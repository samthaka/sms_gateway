package com.smsgateway.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.provider.Settings
import android.telephony.SmsManager
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Call
import okhttp3.Callback
import okhttp3.internal.tls.OkHostnameVerifier
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Date
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class GatewaySecurityModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    const val NAME = "GatewaySecurity"
    private const val KEY_ALIAS = "sms-gateway-pairing-storage"
    private const val PREFERENCES_NAME = "sms_gateway_secure"
    private const val MAX_RESPONSE_BYTES = 1_048_576
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    private val trustAllManager = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val trustAllSocketFactory by lazy {
      SSLContext.getInstance("TLS").apply {
        init(null, arrayOf<TrustManager>(trustAllManager), SecureRandom())
      }.socketFactory
    }
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun getDeviceName(promise: Promise) {
    try {
      promise.resolve(
        Settings.Global.getString(
          reactContext.contentResolver,
          Settings.Global.DEVICE_NAME,
        ),
      )
    } catch (error: Exception) {
      promise.reject("DEVICE_NAME_UNAVAILABLE", error.message, error)
    }
  }

  @ReactMethod
  fun sendSms(phoneNumber: String, message: String, promise: Promise) {
    try {
      require(
        reactContext.checkSelfPermission(Manifest.permission.SEND_SMS) ==
          PackageManager.PERMISSION_GRANTED,
      ) { "SMS permission has not been granted" }
      require(phoneNumber.matches(Regex("^\\+?[0-9]{7,15}$"))) {
        "Phone number is invalid"
      }
      require(message.isNotBlank()) { "SMS message must not be empty" }

      @Suppress("DEPRECATION")
      val smsManager = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
        reactContext.getSystemService(SmsManager::class.java)
      } else {
        SmsManager.getDefault()
      }
      val parts = smsManager.divideMessage(message)
      if (parts.size == 1) {
        smsManager.sendTextMessage(phoneNumber, null, message, null, null)
      } else {
        smsManager.sendMultipartTextMessage(phoneNumber, null, parts, null, null)
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SMS_SEND_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun inspectCertificate(urlText: String, promise: Promise) {
    var connection: HttpsURLConnection? = null
    try {
      val url = URL(urlText)
      require(url.protocol == "https") { "Gateway address must use HTTPS" }

      connection = (url.openConnection() as HttpsURLConnection).apply {
        sslSocketFactory = trustAllSocketFactory
        hostnameVerifier = HostnameVerifier { _, _ -> true }
        connectTimeout = 6000
        readTimeout = 6000
        requestMethod = "GET"
      }
      connection.connect()
      val certificate = connection.serverCertificates
        .firstOrNull() as? X509Certificate
        ?: throw IllegalStateException("Gateway did not provide a certificate")
      val digest = MessageDigest.getInstance("SHA-256")
        .digest(certificate.publicKey.encoded)
      val pin = "sha256/${Base64.encodeToString(digest, Base64.NO_WRAP)}"
      promise.resolve(pin)
    } catch (error: Exception) {
      promise.reject("CERTIFICATE_INSPECTION_FAILED", error.message, error)
    } finally {
      connection?.disconnect()
    }
  }

  @ReactMethod
  fun requestPinned(
    urlText: String,
    pin: String,
    method: String,
    jsonBody: String?,
    token: String?,
    promise: Promise,
  ) {
    try {
      val url = URL(urlText)
      require(url.protocol == "https") { "Gateway address must use HTTPS" }
      require(url.path.startsWith("/v1/")) { "Only versioned gateway routes are allowed" }
      require(pin.matches(Regex("^sha256/[A-Za-z0-9+/]{43}=$"))) {
        "Certificate pin is invalid"
      }
      require(method == "GET" || method == "POST") { "Unsupported gateway method" }

      val expectedPin = Base64.decode(pin.substringAfter('/'), Base64.NO_WRAP)
      // The self-signed gateway is trusted only when its key matches the user-approved pin.
      val pinnedTrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
          val certificate = chain.firstOrNull()
            ?: throw CertificateException("Gateway did not provide a certificate")
          try {
            certificate.checkValidity()
          } catch (error: Exception) {
            throw CertificateException(
              "Device time ${Date()} is outside the gateway certificate validity " +
                "period (${certificate.notBefore} to ${certificate.notAfter}). " +
                "Check automatic date and time settings on this device.",
              error,
            )
          }
          val actualPin = MessageDigest.getInstance("SHA-256")
            .digest(certificate.publicKey.encoded)
          if (!MessageDigest.isEqual(expectedPin, actualPin)) {
            throw CertificateException(
              "Gateway certificate changed. Verify its fingerprint before pairing.",
            )
          }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }
      val pinnedSocketFactory = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf<TrustManager>(pinnedTrustManager), SecureRandom())
      }.socketFactory

      val client = OkHttpClient.Builder()
        .sslSocketFactory(pinnedSocketFactory, pinnedTrustManager)
        .hostnameVerifier(OkHostnameVerifier)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .build()

      val requestBuilder = Request.Builder()
        .url(url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")

      if (!token.isNullOrBlank()) {
        requestBuilder.header("Authorization", "Bearer $token")
      }

      when (method) {
        "GET" -> requestBuilder.get()
        "POST" -> {
          require(!jsonBody.isNullOrBlank()) { "POST requests require a JSON body" }
          requestBuilder.post(jsonBody.toRequestBody(JSON_MEDIA_TYPE))
        }
      }

      client.newCall(requestBuilder.build()).enqueue(
        object : Callback {
          override fun onFailure(call: Call, e: java.io.IOException) {
            promise.reject("GATEWAY_REQUEST_FAILED", e.message, e)
          }

          override fun onResponse(call: Call, response: Response) {
            response.use {
              try {
                val body = it.body
                if (body != null && body.contentLength() > MAX_RESPONSE_BYTES) {
                  promise.reject(
                    "GATEWAY_RESPONSE_TOO_LARGE",
                    "Gateway response exceeded the size limit",
                  )
                  return
                }
                val result = Arguments.createMap().apply {
                  putInt("status", it.code)
                  putString("body", body?.string().orEmpty())
                }
                promise.resolve(result)
              } catch (error: Exception) {
                promise.reject("GATEWAY_RESPONSE_FAILED", error.message, error)
              }
            }
          }
        },
      )
    } catch (error: Exception) {
      promise.reject("GATEWAY_REQUEST_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getSecureValue(key: String, promise: Promise) {
    try {
      validateStorageKey(key)
      val stored = reactContext
        .getSharedPreferences(PREFERENCES_NAME, 0)
        .getString(key, null)
      if (stored == null) {
        promise.resolve(null)
        return
      }

      val decoded = Base64.decode(stored, Base64.NO_WRAP)
      require(decoded.size > 12) { "Stored secure value is invalid" }
      val iv = decoded.copyOfRange(0, 12)
      val ciphertext = decoded.copyOfRange(12, decoded.size)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, getOrCreateStorageKey(), GCMParameterSpec(128, iv))
      promise.resolve(String(cipher.doFinal(ciphertext), Charsets.UTF_8))
    } catch (error: Exception) {
      promise.reject("SECURE_STORAGE_READ_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun setSecureValue(key: String, value: String, promise: Promise) {
    try {
      validateStorageKey(key)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateStorageKey())
      val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      val payload = cipher.iv + ciphertext
      val encoded = Base64.encodeToString(payload, Base64.NO_WRAP)
      val saved = reactContext
        .getSharedPreferences(PREFERENCES_NAME, 0)
        .edit()
        .putString(key, encoded)
        .commit()
      check(saved) { "Could not save encrypted pairing details" }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SECURE_STORAGE_WRITE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun removeSecureValue(key: String, promise: Promise) {
    try {
      validateStorageKey(key)
      val removed = reactContext
        .getSharedPreferences(PREFERENCES_NAME, 0)
        .edit()
        .remove(key)
        .commit()
      check(removed) { "Could not remove encrypted pairing details" }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SECURE_STORAGE_REMOVE_FAILED", error.message, error)
    }
  }

  private fun validateStorageKey(key: String) {
    require(key.matches(Regex("^[a-zA-Z0-9._-]{1,64}$"))) {
      "Secure storage key is invalid"
    }
  }

  private fun getOrCreateStorageKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existingKey = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
    if (existingKey != null) {
      return existingKey
    }

    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      .apply {
        init(
          KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build(),
        )
      }
      .generateKey()
  }
}

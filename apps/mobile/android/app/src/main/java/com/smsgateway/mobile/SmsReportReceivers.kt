package com.smsgateway.mobile

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

internal object SmsReportStore {
  private const val PREFERENCES = "sms_gateway_delivery_reports"

  fun prepare(context: Context, jobId: String, partCount: Int) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putInt("sendParts:$jobId", partCount)
      .putInt("deliveryParts:$jobId", partCount)
      .putLong("created:$jobId", System.currentTimeMillis())
      .commit()
  }

  fun record(context: Context, prefix: String, jobId: String, part: Int, result: Int) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putInt("$prefix:$jobId:$part", result)
      .commit()
  }

  fun sentResult(context: Context, jobId: String): Int? {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val partCount = preferences.getInt("sendParts:$jobId", 0)
    if (partCount == 0) return null
    val results = (0 until partCount).map { part ->
      preferences.getInt("sent:$jobId:$part", Int.MIN_VALUE)
    }
    if (results.any { it == Int.MIN_VALUE }) return null
    val result = results.firstOrNull { it != Activity.RESULT_OK } ?: Activity.RESULT_OK
    preferences.edit().apply {
      remove("sendParts:$jobId")
      (0 until partCount).forEach { remove("sent:$jobId:$it") }
    }.commit()
    return result
  }

  fun pendingDeliveryReports(context: Context): List<Pair<String, Boolean>> {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val reports = mutableListOf<Pair<String, Boolean>>()
    val editor = preferences.edit()
    val cutoff = System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000
    preferences.all.keys
      .filter { it.startsWith("created:") }
      .forEach { key ->
        if (preferences.getLong(key, 0) < cutoff) {
          val jobId = key.removePrefix("created:")
          val partCount = preferences.getInt("deliveryParts:$jobId", 0)
          editor.remove("created:$jobId")
          editor.remove("sendParts:$jobId")
          editor.remove("deliveryParts:$jobId")
          (0 until partCount).forEach { part ->
            editor.remove("sent:$jobId:$part")
            editor.remove("delivery:$jobId:$part")
          }
        }
      }
    editor.commit()
    preferences.all.keys
      .filter { it.startsWith("deliveryParts:") }
      .forEach { key ->
        val jobId = key.removePrefix("deliveryParts:")
        val partCount = preferences.getInt(key, 0)
        val results = (0 until partCount).map { part ->
          preferences.getInt("delivery:$jobId:$part", Int.MIN_VALUE)
        }
        if (partCount > 0 && results.none { it == Int.MIN_VALUE }) {
          reports.add(jobId to results.all { it == Activity.RESULT_OK })
        }
      }
    return reports
  }

  fun acknowledgeDelivery(context: Context, jobId: String) {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val partCount = preferences.getInt("deliveryParts:$jobId", 0)
    preferences.edit().apply {
      remove("deliveryParts:$jobId")
      remove("created:$jobId")
      (0 until partCount).forEach { remove("delivery:$jobId:$it") }
    }.commit()
  }
}

class SmsSentReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val jobId = intent.getStringExtra(EXTRA_JOB_ID) ?: return
    val part = intent.getIntExtra(EXTRA_PART, -1)
    if (part < 0) return
    SmsReportStore.record(context, "sent", jobId, part, resultCode)
  }
}

class SmsDeliveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val jobId = intent.getStringExtra(EXTRA_JOB_ID) ?: return
    val part = intent.getIntExtra(EXTRA_PART, -1)
    if (part < 0) return
    SmsReportStore.record(context, "delivery", jobId, part, resultCode)
  }
}

internal const val EXTRA_JOB_ID = "com.smsgateway.mobile.SMS_JOB_ID"
internal const val EXTRA_PART = "com.smsgateway.mobile.SMS_PART"

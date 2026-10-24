# Database

SQLite migrations and schema definitions for the desktop-hosted gateway belong
here. Keep schema changes versioned and apply them from the desktop main
process; the renderer and mobile app should access data through the gateway API,
not open the database file directly.

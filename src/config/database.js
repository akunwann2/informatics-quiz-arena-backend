
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// Koneksi PostgreSQL Neon
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Fungsi untuk mengetes koneksi database
export async function testDatabaseConnection() {
  let client;

  try {
    client = await db.connect();

    const result = await client.query(
      "SELECT current_database() AS database, NOW() AS server_time"
    );

    console.log("PostgreSQL Neon berhasil terhubung!");
    console.log("Database:", result.rows[0].database);
    console.log("Waktu server:", result.rows[0].server_time);

    return true;
  } catch (error) {
    console.error("Koneksi PostgreSQL gagal:", error.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Menangani error koneksi idle
db.on("error", (error) => {
  console.error("PostgreSQL Pool Error:", error.message);
});

export default db;

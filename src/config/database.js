
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Fungsi untuk mengetes koneksi database
export async function testDatabaseConnection() {
  try {
    const connection = await db.getConnection();

    console.log("MySQL berhasil terhubung!");
    console.log("Database: " + process.env.DB_NAME);

    connection.release();
    return true;
  } catch (error) {
    console.error("Koneksi MySQL gagal:", error.message);
    return false;
  }
}

export default db;

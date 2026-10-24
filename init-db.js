require('dotenv').config();
const mysql = require('mysql2/promise');

async function init() {
  // Kết nối không chọn database để tạo database trước
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${process.env.DB_NAME}\``);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price DECIMAL(12,0) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await conn.query('SELECT COUNT(*) AS total FROM products');
  if (rows[0].total === 0) {
    await conn.query(`
      INSERT INTO products (name, price, description) VALUES
      ('Áo thun', 150000, 'Áo thun cotton'),
      ('Quần jean', 350000, 'Quần jean nam'),
      ('Giày thể thao', 800000, 'Giày chạy bộ')
    `);
  }

  console.log('Tạo database và bảng thành công!');
  await conn.end();
}

init().catch(err => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Kết nối Railway MySQL
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true
});

const ORDER_STATUSES = ["pending", "confirmed", "shipping", "completed", "cancelled"];
const PHONE_RE = /^[0-9+\s.-]{8,20}$/;

// Xử lý lỗi async
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) {
        console.error("API error:", err.code || err.message);
      }
      res.status(status).json({ message: err.message || "Lỗi server." });
    });
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Mã hóa mật khẩu bằng PBKDF2
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

// Kiểm tra mật khẩu
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, originalHash] = stored.split(":");
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  const original = Buffer.from(originalHash, "hex");
  const current = Buffer.from(hash, "hex");
  return original.length === current.length && crypto.timingSafeEqual(original, current);
}

// Token đăng nhập trong bộ nhớ
const activeTokens = new Map();

function generateToken(user) {
  const token = crypto.randomBytes(32).toString("hex");
  activeTokens.set(token, { id: user.id, username: user.username, role: user.role });
  return token;
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ message: "Chưa đăng nhập hoặc token hết hạn." });
  }
  try {
    const session = activeTokens.get(token);
    let rows = [];
    if (session.role === "admin") {
      [rows] = await pool.execute(
        "SELECT role, is_locked FROM admins WHERE id=? AND role='admin'",
        [session.id]
      );
    } else {
      [rows] = await pool.execute("SELECT role, is_locked FROM users WHERE id=?", [session.id]);
    }
    if (!rows[0] || rows[0].is_locked) {
      activeTokens.delete(token);
      return res.status(401).json({ message: "Tài khoản đã bị khóa." });
    }
    req.user = { ...session, role: rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Tài khoản không có quyền thực hiện thao tác này." });
    }
    next();
  };
}

// Kiểm tra kết nối database
app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "connected" });
}));

// Danh sách và tìm kiếm sản phẩm
// Khách hàng chỉ thấy sản phẩm đang bán và không thấy giá nhập.
app.get("/api/products", authMiddleware, wrap(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const keyword = String(req.query.search || "").trim();
  const fields = isAdmin
    ? "p.*"
    : "p.id,p.product_code,p.sku,p.name,p.image,p.category_id,p.brand_id,p.price,p.quantity,p.status,p.low_stock_threshold,p.created_at,p.import_date";
  let sql = `SELECT ${fields}, c.name AS category_name, b.name AS brand_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id WHERE 1=1`;
  const params = [];
  if (keyword) {
    sql += ` AND (p.product_code LIKE ? OR COALESCE(p.sku,'') LIKE ? OR p.name LIKE ?)`;
    const search = `%${keyword}%`;
    params.push(search, search, search);
  }
  if (req.query.category) { sql += " AND p.category_id = ?"; params.push(Number(req.query.category)); }
  if (req.query.brand) { sql += " AND p.brand_id = ?"; params.push(Number(req.query.brand)); }
  if (!isAdmin) {
    sql += " AND p.status = 'active'";
  } else if (req.query.status) {
    sql += " AND p.status = ?";
    params.push(String(req.query.status));
  }
  const sort = ({
    name_asc: "p.name ASC", name_desc: "p.name DESC",
    price_asc: "p.price ASC", price_desc: "p.price DESC",
    quantity_asc: "p.quantity ASC", quantity_desc: "p.quantity DESC",
    newest: "p.id DESC"
  })[req.query.sort] || "p.id DESC";
  sql += " ORDER BY " + sort;
  const [rows] = await pool.execute(sql, params);
  res.json(rows);
}));

// Thêm sản phẩm
app.post("/api/products", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const { product_code, sku, name, category_id, brand_id, image, status,
    cost_price, price, quantity, low_stock_threshold, import_date } = req.body;
  const code = String(sku || product_code || "").trim();
  const productName = String(name || "").trim();
  const productPrice = Number(price);
  const productCost = Number(cost_price || 0);
  const productQuantity = Number(quantity);
  if (
    !code || !productName ||
    !Number.isFinite(productPrice) || productPrice <= 0 ||
    !Number.isInteger(productQuantity) || productQuantity < 0
  ) {
    throw httpError(400, "Vui lòng nhập mã SKU, tên, giá bán và số lượng hợp lệ.");
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO products
       (product_code, sku, name, category_id, brand_id, image, cost_price, price,
        quantity, status, low_stock_threshold, import_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, code, productName, category_id || null, brand_id || null, image || null,
        productCost, productPrice, productQuantity, status === "inactive" ? "inactive" : "active",
        Number(low_stock_threshold || 5), import_date || null]
    );
    res.status(201).json({ message: "Thêm sản phẩm thành công.", id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Mã sản phẩm đã tồn tại.");
    throw error;
  }
}));

app.put("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const quantity = Number(b.quantity);
  const price = Number(b.price);
  const cost = Number(b.cost_price || 0);
  if (!Number.isInteger(quantity) || quantity < 0 || !Number.isFinite(price) || price <= 0) {
    throw httpError(400, "Giá bán và số lượng không hợp lệ.");
  }
  await pool.execute(`
    UPDATE products SET product_code=?, sku=?, name=?, category_id=?, brand_id=?, image=?,
    cost_price=?, price=?, quantity=?, status=?, low_stock_threshold=?, import_date=? WHERE id=?`,
    [b.sku || b.product_code, b.sku || b.product_code, String(b.name || "").trim(),
      b.category_id || null, b.brand_id || null, b.image || null, cost, price, quantity,
      b.status === "inactive" ? "inactive" : "active", Number(b.low_stock_threshold || 5),
      b.import_date || null, id]
  );
  res.json({ message: "Cập nhật sản phẩm thành công." });
}));

app.delete("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM products WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa sản phẩm." });
}));

app.get("/api/categories", wrap(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM categories ORDER BY name");
  res.json(rows);
}));
app.post("/api/categories", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Tên danh mục không được để trống.");
  await pool.execute("INSERT INTO categories (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Đã tạo danh mục." });
}));
app.delete("/api/categories/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM categories WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa danh mục." });
}));

app.get("/api/brands", wrap(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM brands ORDER BY name");
  res.json(rows);
}));
app.post("/api/brands", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Tên thương hiệu không được để trống.");
  await pool.execute("INSERT INTO brands (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Đã tạo thương hiệu." });
}));
app.delete("/api/brands/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM brands WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa thương hiệu." });
}));

// Nhập/xuất kho thủ công
app.post("/api/inventory/movement", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const productId = Number(req.body.product_id);
  const type = req.body.type === "out" ? "out" : "in";
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
    throw httpError(400, "Thông tin nhập/xuất kho không hợp lệ.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT quantity FROM products WHERE id=? FOR UPDATE", [productId]);
    if (!rows[0]) throw httpError(404, "Không tìm thấy sản phẩm.");
    const nextQuantity = type === "in" ? rows[0].quantity + quantity : rows[0].quantity - quantity;
    if (nextQuantity < 0) throw httpError(400, "Số lượng xuất vượt quá tồn kho.");
    await connection.execute("UPDATE products SET quantity=? WHERE id=?", [nextQuantity, productId]);
    await connection.execute(
      "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
      [productId, type, quantity, String(req.body.note || "").trim(), req.user.id, req.user.username]
    );
    await connection.commit();
    res.json({ message: type === "in" ? "Đã nhập kho." : "Đã xuất kho.", quantity: nextQuantity });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

app.get("/api/inventory/movements", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT m.*, p.name AS product_name, p.product_code,
           COALESCE(m.actor_name, u.full_name) AS user_name
    FROM inventory_movements m
    JOIN products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.user_id
    ORDER BY m.created_at DESC LIMIT 300
  `);
  res.json(rows);
}));

app.post("/api/products/import", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const workbook = XLSX.read(req.body.base64, { type: "base64" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  let imported = 0;
  for (const row of rows) {
    const code = String(row.SKU || row.sku || row["Mã SKU"] || "").trim();
    const name = String(row["Tên sản phẩm"] || row.name || "").trim();
    const price = Number(row["Giá bán"] || row.price || 0);
    const cost = Number(row["Giá nhập"] || row.cost_price || 0);
    const quantity = Number(row["Số lượng"] || row.quantity || 0);
    if (!code || !name || !Number.isFinite(price) || price <= 0 || !Number.isInteger(quantity) || quantity < 0) continue;
    await pool.execute(`
      INSERT INTO products (product_code,sku,name,cost_price,price,quantity,status,low_stock_threshold)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE name=VALUES(name),cost_price=VALUES(cost_price),price=VALUES(price),quantity=VALUES(quantity)
    `, [code, code, name, cost, price, quantity, "active", 5]);
    imported++;
  }
  res.json({ message: `Đã nhập ${imported} sản phẩm.`, imported });
}));

// Đăng ký tài khoản khách hàng
app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim().slice(0, 50);
  const fullName = String(req.body.full_name || "").trim().slice(0, 100);
  const password = String(req.body.password || "");

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Nhập đủ họ tên, tên đăng nhập và mật khẩu từ 6 ký tự.");
  }

  // Tên đăng nhập không được trùng với tài khoản quản lý
  const [adminDup] = await pool.execute("SELECT id FROM admins WHERE username=?", [username]);
  if (adminDup[0]) throw httpError(409, "Tên đăng nhập đã tồn tại.");

  try {
    await pool.execute(
      "INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)",
      [username, fullName, hashPassword(password), "viewer"]
    );
    res.status(201).json({ message: "Đăng ký thành công." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Tên đăng nhập đã tồn tại.");
    throw error;
  }
}));

// Đăng nhập
app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const [adminRows] = await pool.execute(
    "SELECT id, username, full_name, password_hash, role, is_locked FROM admins WHERE username=?",
    [username]
  );
  if (adminRows[0]) {
    const admin = adminRows[0];
    if (!verifyPassword(password, admin.password_hash)) {
      throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
    }
    if (admin.is_locked) throw httpError(403, "Tài khoản đã bị khóa.");
    const token = generateToken(admin);
    return res.json({
      token,
      user: { id: admin.id, username: admin.username, full_name: admin.full_name, role: "admin" }
    });
  }

  const [rows] = await pool.execute(
    "SELECT id, username, full_name, password_hash, role, is_locked FROM users WHERE username = ?",
    [username]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
  }
  if (user.is_locked) throw httpError(403, "Tài khoản đã bị khóa.");

  const token = generateToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
  });
}));

// Thông tin người dùng hiện tại
app.get("/api/me", authMiddleware, wrap(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const [rows] = await pool.execute(
    `SELECT id, username, full_name, phone, address, ${isAdmin ? "'admin'" : "role"} AS role
     FROM ${isAdmin ? "admins" : "users"} WHERE id=?`,
    [req.user.id]
  );
  if (!rows[0]) throw httpError(404, "Không tìm thấy người dùng.");
  res.json(rows[0]);
}));

// Cập nhật thông tin cá nhân
app.put("/api/profile", authMiddleware, wrap(async (req, res) => {
  const table = req.user.role === "admin" ? "admins" : "users";
  const fullName = String(req.body.full_name || "").trim().slice(0, 100);
  const phone = String(req.body.phone || "").trim().slice(0, 20);
  const address = String(req.body.address || "").trim().slice(0, 255);
  if (!fullName) throw httpError(400, "Họ tên không được để trống.");
  if (phone && !PHONE_RE.test(phone)) throw httpError(400, "Số điện thoại không hợp lệ.");
  await pool.execute(
    `UPDATE ${table} SET full_name=?, phone=?, address=? WHERE id=?`,
    [fullName, phone || null, address || null, req.user.id]
  );
  res.json({ message: "Đã cập nhật thông tin cá nhân." });
}));

// Đổi mật khẩu của chính mình
app.post("/api/profile/password", authMiddleware, wrap(async (req, res) => {
  const table = req.user.role === "admin" ? "admins" : "users";
  const current = String(req.body.current_password || "");
  const next = String(req.body.new_password || "");
  if (next.length < 6) throw httpError(400, "Mật khẩu mới phải có ít nhất 6 ký tự.");
  const [rows] = await pool.execute(`SELECT password_hash FROM ${table} WHERE id=?`, [req.user.id]);
  if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
    throw httpError(400, "Mật khẩu hiện tại không đúng.");
  }
  await pool.execute(`UPDATE ${table} SET password_hash=? WHERE id=?`, [hashPassword(next), req.user.id]);
  res.json({ message: "Đã đổi mật khẩu." });
}));

// ---------- Đơn hàng ----------

// Hoàn kho và hủy đơn (dùng trong transaction)
async function cancelOrderTx(connection, orderId, actor) {
  const [items] = await connection.execute(
    "SELECT product_id, quantity FROM order_items WHERE order_id=?",
    [orderId]
  );
  for (const item of items) {
    if (!item.product_id) continue;
    await connection.execute("UPDATE products SET quantity=quantity+? WHERE id=?", [item.quantity, item.product_id]);
    await connection.execute(
      "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
      [item.product_id, "in", item.quantity, `Hoàn kho do hủy đơn #${orderId}`, actor.id, actor.username]
    );
  }
  await connection.execute("UPDATE orders SET status='cancelled' WHERE id=?", [orderId]);
}

// Khách hàng đặt hàng. Giá và tồn kho luôn được kiểm tra lại ở server.
app.post("/api/orders", authMiddleware, requireRoles("viewer"), wrap(async (req, res) => {
  const b = req.body;
  const receiver = String(b.receiver_name || "").trim().slice(0, 100);
  const phone = String(b.phone || "").trim().slice(0, 20);
  const address = String(b.address || "").trim().slice(0, 255);
  const note = String(b.note || "").trim().slice(0, 255);
  if (!receiver || !PHONE_RE.test(phone) || !address) {
    throw httpError(400, "Vui lòng nhập tên người nhận, số điện thoại hợp lệ và địa chỉ giao hàng.");
  }

  const wanted = new Map();
  for (const item of Array.isArray(b.items) ? b.items : []) {
    const id = Number(item.product_id);
    const qty = Number(item.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) {
      throw httpError(400, "Giỏ hàng không hợp lệ.");
    }
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size || wanted.size > 50) throw httpError(400, "Giỏ hàng trống hoặc quá lớn.");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let total = 0;
    const lines = [];
    // Khóa theo thứ tự id tăng dần để tránh deadlock
    for (const id of [...wanted.keys()].sort((a, c) => a - c)) {
      const qty = wanted.get(id);
      const [rows] = await connection.execute(
        "SELECT id, product_code, name, price, quantity, status FROM products WHERE id=? FOR UPDATE",
        [id]
      );
      const p = rows[0];
      if (!p || p.status !== "active") throw httpError(400, "Có sản phẩm không còn được bán.");
      if (p.quantity < qty) throw httpError(400, `"${p.name}" chỉ còn ${p.quantity} sản phẩm.`);
      total += p.price * qty;
      lines.push({ p, qty });
    }
    total = Math.round(total * 100) / 100;

    const [result] = await connection.execute(
      `INSERT INTO orders (user_id, customer_username, receiver_name, phone, address, note, total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, req.user.username, receiver, phone, address, note || null, total]
    );
    const orderId = result.insertId;

    for (const { p, qty } of lines) {
      await connection.execute("UPDATE products SET quantity=quantity-? WHERE id=?", [qty, p.id]);
      await connection.execute(
        `INSERT INTO order_items (order_id, product_id, product_name, product_code, price, quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, p.id, p.name, p.product_code, p.price, qty]
      );
      await connection.execute(
        "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
        [p.id, "out", qty, `Đơn hàng #${orderId}`, req.user.id, req.user.username]
      );
    }
    await connection.commit();
    res.status(201).json({ message: `Đặt hàng thành công. Mã đơn #${orderId}.`, id: orderId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Danh sách đơn: khách hàng xem đơn của mình, quản lý xem tất cả
app.get("/api/orders", authMiddleware, wrap(async (req, res) => {
  const params = [];
  let sql = "SELECT * FROM orders WHERE 1=1";
  if (req.user.role !== "admin") {
    sql += " AND user_id=?";
    params.push(req.user.id);
  } else if (ORDER_STATUSES.includes(req.query.status)) {
    sql += " AND status=?";
    params.push(req.query.status);
  }
  sql += " ORDER BY id DESC LIMIT 200";
  const [orders] = await pool.execute(sql, params);
  if (orders.length) {
    const [items] = await pool.query(
      "SELECT * FROM order_items WHERE order_id IN (?) ORDER BY id",
      [orders.map((o) => o.id)]
    );
    for (const o of orders) o.items = items.filter((i) => i.order_id === o.id);
  }
  res.json(orders);
}));

// Khách hàng tự hủy đơn khi còn chờ xác nhận
app.post("/api/orders/:id/cancel", authMiddleware, requireRoles("viewer"), wrap(async (req, res) => {
  const orderId = Number(req.params.id);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT status FROM orders WHERE id=? AND user_id=? FOR UPDATE",
      [orderId, req.user.id]
    );
    if (!rows[0]) throw httpError(404, "Không tìm thấy đơn hàng.");
    if (rows[0].status !== "pending") throw httpError(400, "Chỉ hủy được đơn đang chờ xác nhận.");
    await cancelOrderTx(connection, orderId, req.user);
    await connection.commit();
    res.json({ message: "Đã hủy đơn hàng." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Quản lý đổi trạng thái đơn
app.put("/api/orders/:id/status", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const orderId = Number(req.params.id);
  const status = String(req.body.status || "");
  if (!ORDER_STATUSES.includes(status)) throw httpError(400, "Trạng thái không hợp lệ.");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT status FROM orders WHERE id=? FOR UPDATE", [orderId]);
    if (!rows[0]) throw httpError(404, "Không tìm thấy đơn hàng.");
    if (["completed", "cancelled"].includes(rows[0].status)) {
      throw httpError(400, "Đơn đã kết thúc, không thể đổi trạng thái.");
    }
    if (status === "cancelled") {
      await cancelOrderTx(connection, orderId, req.user);
    } else {
      await connection.execute("UPDATE orders SET status=? WHERE id=?", [status, orderId]);
    }
    await connection.commit();
    res.json({ message: "Đã cập nhật trạng thái đơn hàng." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Thống kê dashboard
app.get("/api/stats", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS total_products,
      COALESCE(SUM(quantity), 0) AS total_stock,
      COALESCE(SUM(quantity * cost_price), 0) AS stock_value
    FROM products
  `);
  const [orderRows] = await pool.execute(`
    SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN total ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS pending
    FROM orders
  `);
  const [lowStock] = await pool.execute(`
    SELECT id, product_code, name, price, quantity, low_stock_threshold, created_at
    FROM products
    WHERE quantity <= low_stock_threshold
    ORDER BY quantity ASC
  `);
  const [movementRows] = await pool.execute(`
    SELECT DATE(created_at) AS day,
      SUM(CASE WHEN type='in' THEN quantity ELSE 0 END) AS incoming,
      SUM(CASE WHEN type='out' THEN quantity ELSE 0 END) AS outgoing
    FROM inventory_movements
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `);
  const chart = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("sv-SE");
    const found = movementRows.find((r) => String(r.day).slice(0, 10) === key);
    chart.push({
      label: d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }),
      incoming: Number(found?.incoming || 0),
      outgoing: Number(found?.outgoing || 0)
    });
  }
  res.json({
    products: Number(rows[0].total_products),
    stock: Number(rows[0].total_stock),
    stockValue: Number(rows[0].stock_value),
    revenue: Number(orderRows[0].revenue),
    pendingOrders: Number(orderRows[0].pending),
    chart,
    lowStock
  });
}));

// ---------- Quản lý tài khoản (chỉ quản lý) ----------

app.get("/api/users", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT id, username, full_name, 'user' AS account_type, role, is_locked, created_at
    FROM users ORDER BY id DESC
  `);
  const [adminRows] = await pool.execute(`
    SELECT id, username, full_name, 'admin' AS account_type, role, is_locked, created_at
    FROM admins ORDER BY id DESC
  `);
  res.json([...adminRows, ...rows]);
}));

app.post("/api/users", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.full_name || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "viewer";

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Thiếu thông tin hoặc mật khẩu quá ngắn.");
  }

  try {
    const passwordHash = hashPassword(password);
    if (role === "admin") {
      await pool.execute(
        `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', FALSE)`,
        [username, fullName, passwordHash]
      );
    } else {
      await pool.execute(
        `INSERT INTO users (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'viewer', FALSE)`,
        [username, fullName, passwordHash]
      );
    }
    res.status(201).json({ message: "Tạo tài khoản thành công." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Tên đăng nhập đã tồn tại.");
    throw error;
  }
}));

// Cập nhật tài khoản (đổi quyền, khóa/mở khóa). Người dùng tự đổi thông tin
// và mật khẩu ở /api/profile nên route này chỉ dành cho quản lý.
app.put("/api/users/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "ID không hợp lệ.");
  }

  let source = null;
  const requestedType = req.body.account_type === "admin" ? "admin" : req.body.account_type === "user" ? "user" : null;
  if (requestedType !== "user") {
    const [adminRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM admins WHERE id=?",
      [targetId]
    );
    if (adminRows[0]) source = { type: "admin", ...adminRows[0] };
  }
  if (!source && requestedType !== "admin") {
    const [userRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM users WHERE id=?",
      [targetId]
    );
    if (userRows[0]) source = { type: "user", ...userRows[0] };
  }
  if (!source) throw httpError(404, "Không tìm thấy tài khoản.");

  const password = req.body.password ? String(req.body.password) : "";
  if (password && password.length < 6) {
    throw httpError(400, "Mật khẩu phải có ít nhất 6 ký tự.");
  }
  const passwordHash = password ? hashPassword(password) : source.password_hash;

  if (req.body.role) {
    const desiredType = req.body.role === "admin" ? "admin" : "user";
    if (source.type !== desiredType) {
      if (desiredType === "admin") {
        await pool.execute(
          `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM users WHERE id=?", [targetId]);
      } else {
        await pool.execute(
          `INSERT INTO users (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'viewer', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
      }
      return res.json({ message: "Cập nhật vai trò thành công." });
    }
  }

  const updateData = { password_hash: passwordHash };
  if (typeof req.body.is_locked === "boolean") {
    updateData.is_locked = req.body.is_locked ? 1 : 0;
  }
  const fields = Object.keys(updateData).map((key) => `${key}=?`);
  const values = [...Object.values(updateData), targetId];
  await pool.execute(
    `UPDATE ${source.type === "admin" ? "admins" : "users"} SET ${fields.join(",")} WHERE id=?`,
    values
  );
  res.json({ message: "Cập nhật thành công." });
}));

// Xóa tài khoản
app.delete("/api/users/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "ID không hợp lệ.");
  }
  if (req.user.id === targetId) {
    throw httpError(400, "Không thể tự xóa tài khoản của chính mình.");
  }

  const [adminResult] = await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
  const [userResult] = await pool.execute("DELETE FROM users WHERE id=?", [targetId]);

  if (adminResult.affectedRows === 0 && userResult.affectedRows === 0) {
    throw httpError(404, "Không tìm thấy tài khoản.");
  }
  res.json({ message: "Đã xóa tài khoản." });
}));

// ---------- Khởi tạo database và chạy server ----------

async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!rows[0].total) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Cột lạ còn sót từ phiên bản cũ mà bắt buộc nhập (NOT NULL, không có giá trị mặc định)
// sẽ làm lệnh INSERT mới bị lỗi, nên đổi chúng thành cho phép NULL.
async function relaxLegacyColumns(connection, table, knownColumns) {
  const [cols] = await connection.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
       AND EXTRA NOT LIKE '%auto_increment%' AND EXTRA NOT LIKE '%GENERATED%'`,
    [table]
  );
  for (const c of cols) {
    if (knownColumns.includes(c.COLUMN_NAME)) continue;
    await connection.execute(`ALTER TABLE ${table} MODIFY \`${c.COLUMN_NAME}\` ${c.COLUMN_TYPE} NULL`);
    console.log(`Đã cho phép NULL: ${table}.${c.COLUMN_NAME}`);
  }
}

async function startServer() {
  try {
    console.log("Đang kết nối Railway MySQL...");
    const connection = await pool.getConnection();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_code VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        quantity INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const productColumns = [
      ["sku", "VARCHAR(100) NULL"],
      ["image", "LONGTEXT NULL"],
      ["category_id", "INT NULL"],
      ["brand_id", "INT NULL"],
      ["cost_price", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["status", "VARCHAR(20) NOT NULL DEFAULT 'active'"],
      ["low_stock_threshold", "INT NOT NULL DEFAULT 5"],
      ["import_date", "DATE NULL"]
    ];
    for (const [column, definition] of productColumns) {
      await ensureColumn(connection, "products", column, definition);
    }
    await connection.execute("UPDATE products SET sku=product_code WHERE sku IS NULL OR sku=''");

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS brands (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        type VARCHAR(10) NOT NULL,
        quantity INT NOT NULL,
        note VARCHAR(255),
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_product_movement (product_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    // Tên người thực hiện (admin và khách hàng nằm ở 2 bảng khác nhau nên lưu thẳng tên)
    await ensureColumn(connection, "inventory_movements", "actor_name", "VARCHAR(100) NULL");

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'admin',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await ensureColumn(connection, "admins", "is_locked", "BOOLEAN NOT NULL DEFAULT FALSE");
    await ensureColumn(connection, "users", "is_locked", "BOOLEAN NOT NULL DEFAULT FALSE");
    // Thông tin cá nhân
    for (const table of ["users", "admins"]) {
      await ensureColumn(connection, table, "phone", "VARCHAR(20) NULL");
      await ensureColumn(connection, table, "address", "VARCHAR(255) NULL");
    }

    await connection.execute("UPDATE users SET role='viewer' WHERE role IN ('staff','warehouse')");
    await connection.execute("UPDATE users SET is_locked=FALSE WHERE role='admin'");

    // Chuyển các tài khoản admin cũ (nếu còn nằm trong bảng users) sang bảng admins
    const [legacyAdmins] = await connection.execute(
      "SELECT username, full_name, password_hash, is_locked FROM users WHERE role='admin'"
    );
    for (const legacyAdmin of legacyAdmins) {
      await connection.execute(
        `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', ?)
         ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), password_hash=VALUES(password_hash), is_locked=VALUES(is_locked)`,
        [legacyAdmin.username, legacyAdmin.full_name, legacyAdmin.password_hash, Boolean(legacyAdmin.is_locked)]
      );
      await connection.execute("DELETE FROM users WHERE username=?", [legacyAdmin.username]);
    }

    // Đơn hàng
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        customer_username VARCHAR(50) NOT NULL,
        receiver_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        address VARCHAR(255) NOT NULL,
        note VARCHAR(255) NULL,
        total DECIMAL(15,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_orders_user (user_id),
        INDEX idx_orders_status (status)
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NULL,
        product_name VARCHAR(255) NOT NULL,
        product_code VARCHAR(100) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);

    // Bổ sung cột còn thiếu nếu bảng orders/order_items đã có từ phiên bản cũ
    const orderColumns = [
      ["user_id", "INT NOT NULL DEFAULT 0"],
      ["customer_username", "VARCHAR(50) NOT NULL DEFAULT ''"],
      ["receiver_name", "VARCHAR(100) NOT NULL DEFAULT ''"],
      ["phone", "VARCHAR(20) NOT NULL DEFAULT ''"],
      ["address", "VARCHAR(255) NOT NULL DEFAULT ''"],
      ["note", "VARCHAR(255) NULL"],
      ["total", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["status", "VARCHAR(20) NOT NULL DEFAULT 'pending'"]
    ];
    for (const [column, definition] of orderColumns) {
      await ensureColumn(connection, "orders", column, definition);
    }
    const itemColumns = [
      ["product_id", "INT NULL"],
      ["product_name", "VARCHAR(255) NOT NULL DEFAULT ''"],
      ["product_code", "VARCHAR(100) NOT NULL DEFAULT ''"],
      ["price", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["quantity", "INT NOT NULL DEFAULT 1"]
    ];
    for (const [column, definition] of itemColumns) {
      await ensureColumn(connection, "order_items", column, definition);
    }
    await relaxLegacyColumns(connection, "orders", ["id"]);
    await relaxLegacyColumns(connection, "order_items", ["id", "order_id"]);

    const adminUsername = String(process.env.ADMIN_USERNAME || "admin").trim();
    const adminPassword = String(process.env.ADMIN_PASSWORD || "Admin123456");
    if (adminUsername && adminPassword.length >= 6) {
      const [adminRows] = await connection.execute("SELECT id FROM admins WHERE username=?", [adminUsername]);
      if (adminRows.length === 0) {
        await connection.execute(
          `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [adminUsername, "Quản lý hệ thống", hashPassword(adminPassword)]
        );
        console.log(`Default admin account created: ${adminUsername}`);
      } else {
        console.log(`Admin account ready: ${adminUsername}`);
      }
    }

    connection.release();
    await pool.query("SELECT 1");

    console.log("MySQL connected successfully.");
    console.log("All tables are ready.");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Application startup failed:");
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    process.exit(1);
  }
}

startServer();
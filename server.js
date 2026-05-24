const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const PORT = process.env.PORT || 3000;

// ---- Database setup (sql.js) ----
const DB_PATH = '/opt/render/project/data/chat.db';
let db;

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      user_id INTEGER,
      contact_id INTEGER,
      PRIMARY KEY(user_id, contact_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender INTEGER NOT NULL,
      receiver INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  saveDb();
}

async function initDatabase() {
  const SQL = await initSqlJs();
  try {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } catch (e) {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  createTables();
}

function runAndSave(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

// ---- Express routes ----
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    runAndSave('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
    res.json({ success: true });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username taken' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, id: user.id, username: user.username });
});

app.get('/contacts', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const contacts = queryAll(`
      SELECT u.id, u.username FROM contacts c
      JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = ?
    `, [id]);
    res.json(contacts);
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

app.post('/add-contact', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { contactUsername } = req.body;
    const contact = queryOne('SELECT id FROM users WHERE username = ?', [contactUsername]);
    if (!contact) return res.status(404).json({ error: 'User not found' });
    runAndSave('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)', [id, contact.id]);
    res.json({ success: true, contactId: contact.id });
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

app.get('/messages/:contactId', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const msgs = queryAll(`
      SELECT * FROM messages
      WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
      ORDER BY timestamp
    `, [id, req.params.contactId, req.params.contactId, id]);
    res.json(msgs);
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

// ---- Socket.io real‑time ----
io.on('connection', (socket) => {
  socket.on('join', (token) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.userId = user.id;
      socket.username = user.username;
      socket.join(`user_${user.id}`);
    } catch { socket.disconnect(); }
  });

  socket.on('private message', ({ to, text }) => {
    if (!socket.userId) return;
    runAndSave('INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)', [socket.userId, to, text]);
    const msg = queryOne('SELECT * FROM messages WHERE id = last_insert_rowid()');
    const payload = {
      id: msg.id,
      sender: socket.userId,
      senderName: socket.username,
      text,
      timestamp: new Date().toISOString()
    };
    io.to(`user_${to}`).emit('private message', payload);
    socket.emit('private message', payload);
  });
});

// ---- Start server after database is ready ----
initDatabase().then(() => {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

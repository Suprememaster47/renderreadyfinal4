/**
 * ---------------------------------------------------------------------
 * MERGED SERVER.JS: N8N CHATBOT + CAPTCHA REVIEWS + PUG TEMPLATES
 * ---------------------------------------------------------------------
 */

import path from "path";
import express from "express";
import compression from "compression";
import session from "express-session";
import errorHandler from "errorhandler";
import lusca from "lusca";
import dotenv from "dotenv";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import passport from "passport";
import rateLimit from "express-rate-limit";
import axios from "axios";
import { WebSocketServer } from "ws";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** --------------------------
 * CONTROLLERS
 * -------------------------- */
const homeController = require("./controllers/home.cjs");
const userController = require("./controllers/user.cjs");
const apiController = require("./controllers/api.cjs");
const aiController = require("./controllers/ai.cjs");
const contactController = require("./controllers/contact.cjs");

/** --------------------------
 * PASSPORT CONFIG
 * -------------------------- */
require("./config/passport.cjs");
const { flash } = require("./config/flash.cjs");
const { morganLogger } = require("./config/morgan.cjs");

/** --------------------------
 * RATE LIMITERS
 * -------------------------- */
const RATE_LIMIT_GLOBAL = parseInt(process.env.RATE_LIMIT_GLOBAL, 10) || 200;
const RATE_LIMIT_STRICT = parseInt(process.env.RATE_LIMIT_STRICT, 10) || 5;
const RATE_LIMIT_LOGIN = parseInt(process.env.RATE_LIMIT_LOGIN, 10) || 10;

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: RATE_LIMIT_GLOBAL });
const strictLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: RATE_LIMIT_STRICT });
const loginLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: RATE_LIMIT_LOGIN });

const secureTransfer = process.env.BASE_URL?.startsWith("https");

/** --------------------------
 * EXPRESS APP SETUP
 * -------------------------- */
const app = express();
app.set("host", "0.0.0.0");
app.set("port", process.env.PORT || 8080);
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.set("trust proxy", secureTransfer ? 1 : 0);

app.use(morganLogger());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(limiter);

app.use(
  session({
    resave: true,
    saveUninitialized: false,
    secret: process.env.SESSION_SECRET || "dev-secret",
    name: "startercookie",
    cookie: { maxAge: 1209600000, secure: secureTransfer },
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(flash);

app.use((req, res, next) => {
  if (req.path === "/api/upload" || req.path === "/ai/togetherai-camera") return next();
  lusca.csrf()(req, res, next);
});

app.use(lusca.xframe("SAMEORIGIN"));
app.use(lusca.xssProtection(true));
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

// Static assets
app.use("/", express.static(path.join(__dirname, "public")));
app.use("/js/lib", express.static(path.join(__dirname, "node_modules/chart.js/dist")));
app.locals.GOOGLE_ANALYTICS_ID = process.env.GOOGLE_ANALYTICS_ID || null;

/** --------------------------
 * ROUTES
 * -------------------------- */
app.get("/", homeController.index);
app.get("/login", userController.getLogin);
app.post("/login", loginLimiter, userController.postLogin);
app.get("/logout", userController.logout);
app.get("/signup", userController.getSignup);
app.post("/signup", userController.postSignup);
app.get("/contact", strictLimiter, contactController.getContact);
app.post("/contact", contactController.postContact);
app.get("/api", apiController.getApi);
app.get("/ai", aiController.getAi);

// 404 handler
app.use((req, res) => res.status(404).send("Page Not Found"));
if (process.env.NODE_ENV === "development") app.use(errorHandler());

/** ---------------------------------------------------------------------
 * MONGODB CONNECTIONS
 * --------------------------------------------------------------------- */
await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
console.log("MongoDB connected ✅");

/** --------------------------
 * REVIEWS WITH CAPTCHA
 * -------------------------- */
const reviewSchema = new mongoose.Schema({
  name: String,
  stars: { type: Number, min: 1, max: 5 },
  review_text: String,
  profile_pic: { type: String, default: "images/default-avatar.png" },
  createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model("Review", reviewSchema);

async function verifyRecaptchaToken(token, remoteip) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) throw new Error('RECAPTCHA_SECRET_KEY not set in .env');
  const params = new URLSearchParams();
  params.append('secret', secret);
  params.append('response', token);
  if (remoteip) params.append('remoteip', remoteip);
  const resp = await axios.post('https://www.google.com/recaptcha/api/siteverify', params);
  return resp.data;
}

app.get('/fetch_reviews', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const totalReviews = await Review.countDocuments();
    const totalPages = Math.ceil(totalReviews / limit);
    const reviews = await Review.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({ reviews, total_pages: totalPages, total_reviews: totalReviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/submit_review', async (req, res) => {
  try {
    const { name, stars, review_text, profile_pic, recaptcha_token } = req.body;
    if (!name || !stars || !review_text)
      return res.json({ success: false, message: 'All fields required' });
    if (!recaptcha_token)
      return res.json({ success: false, message: 'You must complete the CAPTCHA' });

    const verification = await verifyRecaptchaToken(recaptcha_token, req.ip);
    if (!verification.success)
      return res.json({ success: false, message: 'CAPTCHA verification failed' });

    const review = new Review({
      name,
      stars: parseInt(stars),
      review_text,
      profile_pic: profile_pic || undefined
    });
    await review.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message });
  }
});

/** ---------------------------------------------------------------------
 * N8N CHATBOT INTEGRATION
 * --------------------------------------------------------------------- */
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const CHATBOT_MONGODB_URI = process.env.MONGODB_URI;

const mongoClient = new MongoClient(CHATBOT_MONGODB_URI, { connectTimeoutMS: 10000 });
let responsesCollection = null;

async function initChatbotMongo() {
  await mongoClient.connect();
  const db = mongoClient.db("test");
  responsesCollection = db.collection("responses");
  await responsesCollection.createIndex({ sessionId: 1, timestamp: -1 });
  console.log("Chatbot Mongo connected (test.responses)");
}
initChatbotMongo();

async function saveMessage({ sessionId, sender, message, meta = {} }) {
  if (!responsesCollection) return;
  await responsesCollection.insertOne({ sessionId, sender, message, meta, timestamp: new Date() });
}

// HTTP endpoint for chatbot
app.post("/send-to-n8n", async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });
  try {
    await saveMessage({ sessionId, sender: "user", message });
    const resp = await axios.post(N8N_WEBHOOK_URL, { message, sessionId });
    let reply = typeof resp.data === "string" ? resp.data : resp.data.reply || JSON.stringify(resp.data);
    await saveMessage({ sessionId, sender: "bot", message: reply });
    res.json({ reply });
  } catch (err) {
    console.error("N8N POST error:", err.message);
    res.status(500).json({ error: "Failed to contact n8n" });
  }
});

// WebSocket server for chatbot
const server = app.listen(app.get("port"), () => {
  console.log(`Server running on http://localhost:${app.get("port")}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isBusy = false;
  ws.on("message", async (raw) => {
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ error: "Invalid JSON" })); return; }
    const message = String(payload.message || "").trim();
    const sessionId = payload.sessionId || `s_${Date.now().toString(36)}`;
    if (!message) { ws.send(JSON.stringify({ error: "No message" })); return; }
    if (ws.isBusy) { ws.send(JSON.stringify({ error: "Processing previous message" })); return; }
    ws.isBusy = true;
    try {
      await saveMessage({ sessionId, sender: "user", message });
      if (!N8N_WEBHOOK_URL) { ws.send(JSON.stringify({ reply: "n8n webhook not configured" })); ws.isBusy = false; return; }
      const resp = await axios.post(N8N_WEBHOOK_URL, { message, sessionId }, { timeout: 120000 });
      let reply = typeof resp.data === "string" ? resp.data : resp.data.reply || JSON.stringify(resp.data);
      await saveMessage({ sessionId, sender: "bot", message: reply });
      ws.send(JSON.stringify({ reply, sessionId }));
    } catch (err) {
      console.error("WS -> n8n err:", err?.message || err);
      ws.send(JSON.stringify({ error: "Server error contacting n8n" }));
    } finally { ws.isBusy = false; }
  });
  ws.on("close", () => {});
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  try { await mongoose.disconnect(); } catch {}
  server.close(() => process.exit(0));
});

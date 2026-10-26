const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();
const path = require("path");
const Groq = require("groq-sdk");
const multer = require("multer");
const fs = require("fs");

const crypto = require("crypto");
const { MercadoPagoConfig, Payment, Preference } = require("mercadopago");

const upload = multer({ dest: "uploads/" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());

// Inicializar Firebase Admin - Diferentes enfoques
let serviceAccount;

if (process.env.NODE_ENV === "production") {
  // Para producción - desde variable de entorno
  console.log("📦 Modo producción - cargando desde variable de entorno");

  try {
    // Intentar parsear el JSON directamente
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    console.error("❌ Error parsing service account:", error.message);

    // Fallback: intentar cargar desde Base64
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      console.log("🔄 Intentando cargar desde Base64...");
      const serviceAccountJSON = Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
        "base64",
      ).toString("utf8");
      serviceAccount = JSON.parse(serviceAccountJSON);
    } else {
      throw new Error("No se pudo cargar la service account");
    }
  }
} else {
  // Para desarrollo - desde archivo
  console.log("🔧 Modo desarrollo - cargando desde archivo");
  try {
    serviceAccount = require("./script/bilingualsite-ee6f8-firebase-adminsdk-fbsvc-c5303ad4e0.json");
  } catch (error) {
    console.error("❌ Error cargando archivo service account:", error.message);
    process.exit(1);
  }
}

// Asegurar que la private key tenga saltos de línea correctos
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

console.log("✅ Service account cargada correctamente");
console.log("📧 Client email:", serviceAccount.client_email);

// Inicializar Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();
console.log("✅ Firebase Admin inicializado correctamente");

// Keep-alive liviano para el cron externo (cron-job.org): no toca Firestore
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()) });
});

// Agrega esto antes de las rutas principales
app.get("/wake-up", async (req, res) => {
  console.log("☀️ Backend awakened at:", new Date().toISOString());

  try {
    // Hacer una pequeña operación de Firestore para precalentar
    const testRef = db.collection("wakeup").doc("test");
    await testRef.set(
      {
        lastWakeup: new Date().toISOString(),
      },
      { merge: true },
    );

    res.json({
      status: "awake",
      timestamp: new Date().toISOString(),
      message: "Backend and database prewarmed",
    });
  } catch (error) {
    // Aún así responder aunque falle el precalentamiento de DB
    res.json({
      status: "awake",
      timestamp: new Date().toISOString(),
      message: "Backend awake (db prewarm failed)",
    });
  }
});

// audio

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let tempPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    // RENOMBRAR EL ARCHIVO PARA QUE TENGA EXTENSIÓN (Groq es estricto con esto)
    // Se respeta la del archivo subido: Chrome graba webm, Safari mp4/m4a, Android m4a.
    const ext = (path.extname(req.file.originalname || "").slice(1) || "m4a").toLowerCase();
    const allowed = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "opus", "wav", "webm"];
    tempPath = `${req.file.path}.${allowed.includes(ext) ? ext : "m4a"}`;
    fs.renameSync(req.file.path, tempPath);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath), // Enviamos el archivo con la extensión .m4a
      model: "whisper-large-v3",
      language: "en",
    });

    // Limpiar archivo renombrado
    fs.unlinkSync(tempPath);

    res.json({ text: transcription.text });
  } catch (error) {
    console.error("❌ Error en Groq:", error);

    // Limpieza de emergencia
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.status(500).json({
      error: "Error al procesar el audio",
      details: error.message,
    });
  }
});

// Verificar si un usuario tiene un nivel comprado - CORREGIDO
app.get("/check-level-access/:userId/:levelId", async (req, res) => {
  try {
    const { userId, levelId } = req.params;

    // CORRECCIÓN: Usa la sintaxis de admin.firestore()
    const userProgressRef = db.collection("userProgress").doc(userId);
    const userProgressSnap = await userProgressRef.get();

    if (!userProgressSnap.exists) {
      return res
        .status(404)
        .json({ hasAccess: false, error: "User not found" });
    }

    const userProgress = userProgressSnap.data();
    const hasAccess = userProgress.unlockedLevels?.includes(levelId) || false;

    res.json({
      hasAccess,
      unlockedLevels: userProgress.unlockedLevels || ["A1"],
      purchasedLevels: userProgress.purchasedLevels || {},
    });
  } catch (error) {
    console.error("Error checking level access:", error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar acceso a múltiples niveles
app.get("/check-level-access/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // CORRECCIÓN
    const userProgressRef = db.collection("userProgress").doc(userId);
    const userProgressSnap = await userProgressRef.get();

    if (!userProgressSnap.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userProgress = userProgressSnap.data();

    res.json({
      unlockedLevels: userProgress.unlockedLevels || ["A1"],
      purchasedLevels: userProgress.purchasedLevels || {},
    });
  } catch (error) {
    console.error("Error checking level access:", error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== MERCADO PAGO =====================

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN, // TEST-... en pruebas, APP_USR-... en producción
});

const MP_CURRENCY = "COP";

// Precios en dólares (lo que ve el usuario). Se cobran en COP convertidos con
// la TRM del día. Sobreescribibles con PRICE_A1_USD / PRICE_A2_USD / PRICE_B1_USD.
const LEVEL_PRICES_USD = {
  A1: Number(process.env.PRICE_A1_USD) || 12,
  A2: Number(process.env.PRICE_A2_USD) || 18,
  // B1 "Próximamente": sin contenido, no está a la venta. Para habilitarlo,
  // agregar B1: Number(process.env.PRICE_B1_USD) y quitar comingSoon en la app.
};

// ===== Tasa USD -> COP =====
// 1° TRM oficial (Superfinanciera, vía datos.gov.co). 2° open.er-api.com.
// 3° última tasa obtenida. 4° USD_COP_FALLBACK (env).
const FX_CACHE_MS = 6 * 60 * 60 * 1000;
const FX_SOURCES = [
  {
    name: "TRM datos.gov.co",
    url: "https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1",
    parse: (data) => Number(data?.[0]?.valor),
  },
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    parse: (data) => Number(data?.rates?.COP),
  },
];
let fxCache = { rate: null, source: null, fetchedAt: 0 };

async function getUsdToCop() {
  if (fxCache.rate && Date.now() - fxCache.fetchedAt < FX_CACHE_MS) {
    return fxCache;
  }

  for (const source of FX_SOURCES) {
    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const rate = source.parse(await response.json());
      // Sanity check: descarta valores absurdos
      if (rate > 1000 && rate < 20000) {
        fxCache = { rate, source: source.name, fetchedAt: Date.now() };
        return fxCache;
      }
    } catch (error) {
      console.warn(`⚠️ Tasa USD/COP no disponible en ${source.name}:`, error.message);
    }
  }

  if (fxCache.rate) return fxCache; // tasa vieja antes que nada

  const fallback = Number(process.env.USD_COP_FALLBACK) || 3200;
  return { rate: fallback, source: "fallback", fetchedAt: Date.now() };
}

// Redondea hacia arriba a la centena para un precio "limpio" en pesos
const usdToCop = (usd, rate) => Math.ceil((usd * rate) / 100) * 100;

// Mínimo aceptable en COP para un nivel, por si llega un external_reference
// sin monto (pagos creados antes de este cambio)
const MIN_USD_COP_RATE = 2000;

// Verifica el ID token de Firebase enviado como "Authorization: Bearer <token>"
async function requireFirebaseUser(req, res, next) {
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Falta token de autenticación" });
  }
  try {
    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// Valida la firma x-signature de las notificaciones de MP.
// Si MP_WEBHOOK_SECRET no está configurada, se omite (el pago igual se
// re-consulta a la API de MP, así que no se confía en el body).
function isValidMpSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (!signature || !dataId) return false;

  const parts = Object.fromEntries(
    signature.split(",").map((part) => part.trim().split("=")),
  );
  if (!parts.ts || !parts.v1) return false;

  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  return (
    expected.length === parts.v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  );
}

// Consulta un pago en MP y, si está aprobado, desbloquea el nivel.
// Idempotente: se puede llamar desde el webhook y desde /verify-payment.
async function processMpPayment(paymentId) {
  const payment = await new Payment(mpClient).get({ id: paymentId });

  // external_reference = "uid:levelId:montoCOP" (lo arma el backend al crear la
  // preferencia, el comprador no lo puede modificar)
  const [userId, levelId, copAmount] = (payment.external_reference || "").split(
    ":",
  );
  const result = { status: payment.status, levelId, userId };

  if (payment.status !== "approved") return result;

  // Se valida contra el monto fijado al crear la preferencia, no contra la
  // tasa actual (puede haber cambiado entre la creación y el pago)
  const usdPrice = LEVEL_PRICES_USD[levelId];
  const expectedPrice = usdPrice
    ? Math.max(Number(copAmount) || 0, usdPrice * MIN_USD_COP_RATE)
    : 0;
  if (
    !userId ||
    !expectedPrice ||
    payment.currency_id !== MP_CURRENCY ||
    payment.transaction_amount < expectedPrice
  ) {
    console.error("❌ Pago MP inconsistente:", {
      paymentId,
      external_reference: payment.external_reference,
      amount: payment.transaction_amount,
      currency: payment.currency_id,
    });
    return { ...result, status: "invalid" };
  }

  const paymentRef = db.collection("payments").doc(`mp_${payment.id}`);
  const userProgressRef = db.collection("userProgress").doc(userId);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(paymentRef);
    if (existing.exists) return;

    tx.set(paymentRef, {
      provider: "mercadopago",
      paymentId: payment.id,
      userId,
      levelId,
      amount: payment.transaction_amount,
      currency: payment.currency_id,
      status: payment.status,
      liveMode: payment.live_mode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(
      userProgressRef,
      {
        purchasedLevels: { [levelId]: true },
        unlockedLevels: admin.firestore.FieldValue.arrayUnion(levelId),
        lastPurchase: new Date(),
      },
      { merge: true },
    );
  });

  console.log(`✅ Pago MP aprobado: User ${userId} -> Level ${levelId}`);
  return result;
}

// Precios para mostrar en la app
app.get("/level-prices", async (req, res) => {
  const fx = await getUsdToCop();
  const pricesCop = Object.fromEntries(
    Object.entries(LEVEL_PRICES_USD).map(([level, usd]) => [
      level,
      usdToCop(usd, fx.rate),
    ]),
  );

  res.json({
    currency: "USD",
    prices: LEVEL_PRICES_USD,
    chargeCurrency: MP_CURRENCY,
    chargePrices: pricesCop,
    usdCopRate: fx.rate,
    rateSource: fx.source,
  });
});

// Cupones de 100%: desbloquean el nivel sin pasar por MP.
// Doc coupons/<CÓDIGO EN MAYÚSCULAS>: { levels: ["A1", "A2"], maxUses, uses, active, expiresAt? }.
// Cada canje (usuario + nivel) consume un uso; un usuario no repite el cupón en el mismo nivel.
app.post("/redeem-coupon", requireFirebaseUser, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const { levelId } = req.body;
  const userId = req.user.uid;

  if (!LEVEL_PRICES_USD[levelId]) {
    return res.status(400).json({ error: `Nivel no válido: ${levelId}` });
  }
  if (!code || code.includes("/")) {
    return res.status(400).json({ error: "Cupón no válido" });
  }

  const couponRef = db.collection("coupons").doc(code);
  const redemptionRef = couponRef
    .collection("redemptions")
    .doc(`${userId}_${levelId}`);
  const userProgressRef = db.collection("userProgress").doc(userId);

  try {
    await db.runTransaction(async (tx) => {
      const [coupon, redemption, progress] = await Promise.all([
        tx.get(couponRef),
        tx.get(redemptionRef),
        tx.get(userProgressRef),
      ]);
      const data = coupon.data();

      const fail = (status, message) => {
        throw Object.assign(new Error(message), { status });
      };
      if (!coupon.exists || data.active === false) fail(404, "Cupón no válido");
      if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) {
        fail(410, "Este cupón venció");
      }
      if (!(data.levels || []).includes(levelId)) {
        fail(400, `Este cupón no aplica al nivel ${levelId}`);
      }
      if (progress.data()?.purchasedLevels?.[levelId]) {
        fail(409, `Ya tienes el nivel ${levelId}`);
      }
      if (redemption.exists) fail(409, "Ya usaste este cupón en este nivel");
      if ((data.uses || 0) >= data.maxUses) fail(410, "Este cupón ya se agotó");

      tx.update(couponRef, { uses: admin.firestore.FieldValue.increment(1) });
      tx.set(redemptionRef, {
        userId,
        levelId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("payments").doc(`coupon_${code}_${userId}_${levelId}`), {
        provider: "coupon",
        coupon: code,
        userId,
        levelId,
        amount: 0,
        status: "approved",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(
        userProgressRef,
        {
          purchasedLevels: { [levelId]: true },
          unlockedLevels: admin.firestore.FieldValue.arrayUnion(levelId),
          lastPurchase: new Date(),
        },
        { merge: true },
      );
    });

    console.log(`🎟️ Cupón ${code}: User ${userId} -> Level ${levelId}`);
    res.json({ success: true, levelId });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("❌ Error canjeando cupón:", error);
    res.status(500).json({ error: "No se pudo aplicar el cupón" });
  }
});

// 1. Crear preferencia de Checkout Pro
app.post("/create-preference", requireFirebaseUser, async (req, res) => {
  try {
    const { levelId } = req.body;
    const userId = req.user.uid;
    const usdPrice = LEVEL_PRICES_USD[levelId];

    if (!usdPrice) {
      return res.status(400).json({ error: `Nivel no válido: ${levelId}` });
    }

    const fx = await getUsdToCop();
    const price = usdToCop(usdPrice, fx.rate);

    const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
    const backendUrl = (process.env.BACKEND_URL || "").replace(/\/$/, "");

    const body = {
      items: [
        {
          id: levelId,
          title: `Curso de Inglés Nivel ${levelId}`,
          quantity: 1,
          unit_price: price,
          currency_id: MP_CURRENCY,
        },
      ],
      payer: req.user.email ? { email: req.user.email } : undefined,
      external_reference: `${userId}:${levelId}:${price}`,
      back_urls: {
        success: `${frontendUrl}/payment-success`,
        pending: `${frontendUrl}/payment-success`,
        failure: `${frontendUrl}/payment-cancel`,
      },
      statement_descriptor: "BILINGUALSITE",
    };

    // MP solo acepta auto_return / notification_url con URLs públicas https
    if (frontendUrl.startsWith("https://")) body.auto_return = "approved";
    if (backendUrl.startsWith("https://")) {
      body.notification_url = `${backendUrl}/mp-webhook`;
    }

    const preference = await new Preference(mpClient).create({ body });

    res.json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point,
    });
  } catch (error) {
    console.error("❌ MP Error:", error);
    res.status(500).json({ error: "No se pudo crear el pago" });
  }
});

// 2. Verificar pago al volver del checkout (payment_id viene en la URL)
app.get("/verify-payment/:paymentId", async (req, res) => {
  try {
    const result = await processMpPayment(req.params.paymentId);
    res.json({ status: result.status, levelId: result.levelId });
  } catch (error) {
    console.error("❌ Error verificando pago MP:", error);
    res.status(500).json({ error: "No se pudo verificar el pago" });
  }
});

// 3. Webhook (notificación de pago)
app.post("/mp-webhook", async (req, res) => {
  const type = req.body?.type || req.query.type || req.query.topic;
  const dataId = req.query["data.id"] || req.body?.data?.id || req.query.id;

  if (!isValidMpSignature(req, dataId)) {
    console.warn("⚠️ Webhook MP con firma inválida");
    return res.sendStatus(401);
  }

  if (type !== "payment" || !dataId) return res.sendStatus(200);

  try {
    await processMpPayment(dataId);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook MP Error:", error);
    res.sendStatus(500); // MP reintenta
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

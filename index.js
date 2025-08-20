const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
require("dotenv").config();

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
        "base64"
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
    serviceAccount = require("./script/bilingual-site-65404-firebase-adminsdk-fbsvc-c79e697c2a.json");
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

// Precios de los niveles (deberían coincidir con tus productos en Stripe)
const LEVEL_PRICES = {
  A1: "price_1RyFaaIlL7CBuxtZG47D4jKY",
  A2: "price_1RyFb5IlL7CBuxtZUSHsM4fP",
  B1: "price_1RyFbHIlL7CBuxtZz1GG0zhv",
};

// Crear sesión de checkout
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("Received checkout request:", req.body);

    const { levelId, userId, successUrl, cancelUrl } = req.body;

    if (!levelId || !userId) {
      return res.status(400).json({ error: "levelId and userId are required" });
    }

    const priceId = LEVEL_PRICES[levelId];
    if (!priceId) {
      return res.status(400).json({
        error: `Invalid level ID: ${levelId}. Available levels: ${Object.keys(
          LEVEL_PRICES
        ).join(", ")}`,
      });
    }

    // Verificar que el priceId sea válido (empiece con price_)
    if (!priceId.startsWith("price_")) {
      return res.status(400).json({
        error: `Invalid price ID format for level ${levelId}. Expected 'price_xxx', got '${priceId}'`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url:
        successUrl ||
        `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/payment-cancel`,
      metadata: {
        userId: userId,
        levelId: levelId,
      },
    });

    console.log("✅ Checkout session created:", session.id);
    res.json({ sessionId: session.id });
  } catch (error) {
    console.error("❌ Error creating checkout session:", error);

    // Dar mejor feedback sobre el error
    if (error.type === "StripeInvalidRequestError") {
      res.status(400).json({
        error: "Invalid Stripe request",
        details: error.message,
        suggestion: "Check if the price ID exists and is active in Stripe",
      });
    } else {
      res.status(500).json({
        error: error.message,
        details: "Check Stripe configuration",
      });
    }
  }
});

// Endpoint para verificar estado de pago
app.get("/verify-payment/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      status: session.payment_status,
      levelId: session.metadata.levelId,
      userId: session.metadata.userId,
      amount: session.amount_total / 100,
      currency: session.currency,
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook mejorado con reintentos
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`✅ Webhook received: ${event.type}`);

    // Manejar el evento de checkout completado
    // Webhook corregido
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        if (session.payment_status !== "paid") {
          console.log(`ℹ️ Payment not completed for session: ${session.id}`);
          return res.json({ received: true, status: "not_paid" });
        }

        const userId = session.metadata.userId;
        const levelId = session.metadata.levelId;

        console.log(
          `🛒 Processing purchase for user ${userId}, level ${levelId}`
        );

        // CORRECCIÓN: Sintaxis corregida
        const userProgressRef = db.collection("userProgress").doc(userId);
        const userProgressSnap = await userProgressRef.get();

        if (!userProgressSnap.exists) {
          console.error(`❌ User progress not found for ${userId}`);
          return res.status(404).json({ error: "User not found" });
        }

        const userProgress = userProgressSnap.data();

        if (userProgress.purchasedLevels?.[levelId]) {
          console.log(
            `ℹ️ Level ${levelId} already purchased for user ${userId}`
          );
          return res.json({ received: true, status: "already_purchased" });
        }

        // CORRECCIÓN: Usa FieldValue.arrayUnion
        const updateData = {
          [`purchasedLevels.${levelId}`]: true,
          lastPurchase: new Date(),
        };

        if (!userProgress.unlockedLevels?.includes(levelId)) {
          updateData.unlockedLevels =
            admin.firestore.FieldValue.arrayUnion(levelId);
        }

        // CORRECCIÓN: Sintaxis corregida
        await userProgressRef.update(updateData);

        console.log(
          `✅ Purchase completed: User ${userId} -> Level ${levelId}`
        );
      } catch (error) {
        console.error("❌ Error processing webhook:", error);
        return res.status(500).json({ error: "Failed to process webhook" });
      }
    }

    res.json({ received: true });
  }
);

// Función para reintentar webhooks fallidos
async function retryFailedWebhook(event) {
  console.log("🔄 Retrying failed webhook...");

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const levelId = session.metadata.levelId;

    const userProgressRef = doc(db, "userProgress", userId);

    const updateData = {
      [`purchasedLevels.${levelId}`]: true,
      lastPurchase: new Date(),
    };

    // Solo agregar a unlockedLevels si no existe ya
    if (!userProgress.unlockedLevels?.includes(levelId)) {
      updateData.unlockedLevels = arrayUnion(levelId);
    }

    await updateDoc(userProgressRef, updateData);

    console.log("✅ Retry successful");
  }
}

// Verificar si un usuario tiene un nivel comprado
app.get("/check-level-access/:userId/:levelId", async (req, res) => {
  try {
    const { userId, levelId } = req.params;

    // CORRECCIÓN: Usa la sintaxis de admin.firestore()
    const userProgressRef = db.collection("userProgress").doc(userId);
    const userProgressSnap = await userProgressRef.get();

    if (!userProgressSnap.exists) {
      return res.status(404).json({ hasAccess: false, error: "User not found" });
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

// Verificar estado de pago
app.get("/check-payment-status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      status: session.payment_status,
      levelId: session.metadata.levelId,
      userId: session.metadata.userId,
    });
  } catch (error) {
    console.error("Error checking payment status:", error);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

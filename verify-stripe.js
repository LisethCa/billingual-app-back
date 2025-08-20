// verify-stripe.js
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

async function verifyStripe() {
  try {
    // Verificar que la API key funciona
    const balance = await stripe.balance.retrieve();
    console.log("✅ Stripe API key is valid");
    console.log("💰 Balance available:", balance.available[0].amount / 100);

    // Listar productos existentes
    const products = await stripe.products.list({ limit: 10 });
    console.log("\n📦 Products available:");
    products.data.forEach((product) => {
      console.log(`- ${product.name} (${product.id})`);
    });

    // Listar precios
    const prices = await stripe.prices.list({ limit: 10 });
    console.log("\n💵 Prices available:");
    prices.data.forEach((price) => {
      console.log(
        `- ${price.id}: ${price.unit_amount / 100} ${price.currency}`
      );
    });
  } catch (error) {
    console.error("❌ Stripe verification failed:", error.message);
  }
}

verifyStripe();

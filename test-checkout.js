// test-checkout.js
require("dotenv").config({ path: ".env" });
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

async function testPriceIDs() {
  console.log("🧪 Probando Price IDs...");

  const testPriceIDs = [
    "price_1RyFaaIlL7CBuxtZG47D4jKY", // Reemplaza con tus price IDs reales
    "price_1RyFb5IlL7CBuxtZUSHsM4fP",
    "price_1RyFbHIlL7CBuxtZz1GG0zhv",
  ];

  for (const priceId of testPriceIDs) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      console.log(
        `✅ ${priceId}: ${price.unit_amount / 100} ${price.currency} (${
          price.product
        })`
      );
    } catch (error) {
      console.log(`❌ ${priceId}: ${error.message}`);
    }
  }
}

testPriceIDs();

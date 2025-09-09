// test-checkout.js
require("dotenv").config({ path: ".env" });
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

async function testPriceIDs() {
  console.log("🧪 Probando Price IDs...");

  const testPriceIDs = [
    "price_1S3hprFHOc1l5YQOcaq3BCSI", // Reemplaza con tus price IDs reales
    "price_1S3hpTFHOc1l5YQOZb80Ias7",
    "price_1S3hnaFHOc1l5YQOAhXVaMy4",
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

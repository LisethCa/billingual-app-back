// convert-to-base64.js
const fs = require("fs");
const path = require("path");

const serviceAccountPath = path.join(
  __dirname,
  "./script/bilingual-site-65404-firebase-adminsdk-fbsvc-c79e697c2a.json"
);

try {
  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8")
  );
  const base64String = Buffer.from(JSON.stringify(serviceAccount)).toString(
    "base64"
  );

  console.log("✅ FIREBASE_SERVICE_ACCOUNT_BASE64 para Render:");
  console.log("");
  console.log(base64String);
  console.log("");
  console.log("📋 Instrucciones:");
  console.log("1. Copia este valor");
  console.log("2. Ve a Render.com → Environment");
  console.log("3. Añade variable: FIREBASE_SERVICE_ACCOUNT_BASE64");
  console.log("4. Pega el valor");
  console.log("5. Elimina la variable FIREBASE_SERVICE_ACCOUNT antigua");
} catch (error) {
  console.error("❌ Error:", error.message);
}

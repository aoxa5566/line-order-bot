const express = require("express");
const { Client } = require("@line/bot-sdk");
const { google } = require("googleapis");
const redis = require("redis");
const dotenv = require("dotenv");

dotenv.config(); // 讀取環境變數

const app = express();

// 初始化LINE Bot SDK 客戶端
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, // 使用環境變數
  channelSecret: process.env.LINE_CHANNEL_SECRET, // 使用環境變數
});

// 連接到 Redis
const clientRedis = redis.createClient({
  host: process.env.REDIS_HOST, // Redis 主機
  port: process.env.REDIS_PORT, // Redis 端口
});

clientRedis.on("error", (err) => {
  console.log("Redis connection error: ", err);
});

// 設置 Google Sheets API
const sheets = google.sheets("v4");

// 讀取 Google 試算表中的產品資料
async function getProducts() {
  try {
    const auth = await google.auth.getClient({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const response = await sheets.spreadsheets.values.get({
      auth,
      spreadsheetId: process.env.GOOGLE_SHEET_ID, // 使用環境變數
      range: "Sheet1!A:B", // 只讀取品名和說明
    });

    return response.data.values || [];
  } catch (error) {
    console.error("Error fetching products from Google Sheets:", error);
    return [];
  }
}

// 生成產品選擇按鈕
const productButtons = (products) => {
  return products.map((product) => ({
    type: "message",
    label: product[0], // 顯示品名
    text: `選擇${product[0]}`,
  }));
};

// 生成訂單總結
function generateOrderSummary(selectedProducts, allProducts) {
  let selected = "";
  let notSelected = "";

  allProducts.forEach((product) => {
    if (selectedProducts.includes(product[0])) {
      selected += `${product[0]}: ${product[1]}\n`; // 顯示品名和說明
    } else {
      notSelected += `${product[0]}\n`; // 只顯示品名
    }
  });

  return {
    selected,
    notSelected,
  };
}

// 根路由處理
app.get("/", (req, res) => {
  res.send("LINE訂貨機器人伺服器已啟動！");
});

// Webhook 處理
app.post("/webhook", express.json(), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;
        const userId = event.source.userId;

        // 當用戶輸入 '訂貨' 時，顯示產品選擇按鈕
        if (userMessage === "訂貨") {
          const products = await getProducts();
          client.pushMessage(userId, {
            type: "template",
            altText: "選擇產品",
            template: {
              type: "buttons",
              title: "選擇產品",
              text: "請選擇您要的產品",
              actions: productButtons(products),
            },
          });
        }
        // 用戶選擇產品後，提示用戶輸入數量
        else if (userMessage.startsWith("選擇")) {
          const product = userMessage.replace("選擇", "").trim();
          client.pushMessage(userId, {
            type: "text",
            text: `請輸入您選擇的${product}的數量。`,
          });
          // 存儲選擇的產品
          clientRedis.setex(
            userId,
            1800,
            JSON.stringify({ product, quantity: 0 })
          ); // 設定30分鐘過期
        }
        // 用戶輸入數量
        else if (userMessage.match(/^\d+$/)) {
          clientRedis.get(userId, (err, data) => {
            if (err) {
              console.error("Redis Error:", err);
              return;
            }
            const order = data ? JSON.parse(data) : {};
            order.quantity = parseInt(userMessage);
            clientRedis.setex(userId, 1800, JSON.stringify(order));

            client.pushMessage(userId, {
              type: "text",
              text: `您選擇的${order.product}數量是：${order.quantity}`,
            });
          });
        }
        // 顯示訂單總結
        else if (userMessage === "總結訂單") {
          const allProducts = await getProducts();
          clientRedis.get(userId, (err, data) => {
            if (err) {
              console.error("Redis Error:", err);
              return;
            }
            const order = data ? JSON.parse(data) : {};

            const { selected, notSelected } = generateOrderSummary(
              [order.product],
              allProducts
            );

            client.pushMessage(userId, {
              type: "text",
              text: `已選擇的產品：\n${selected}`,
            });

            client.pushMessage(userId, {
              type: "text",
              text: `未選擇的商品：\n${notSelected}`,
            });
          });
        }
      }
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// 啟動伺服器
app.listen(3000, () => {
  console.log("Server is running");
});

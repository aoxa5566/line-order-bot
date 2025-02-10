const express = require("express");
const { google } = require("googleapis");
const { Client, middleware } = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

// Google Sheets 認證設置
const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, "credentials.json"))
); // 下載的 JSON 憑證文件
const oAuth2Client = new google.auth.OAuth2(
  credentials.installed.client_id, // 安裝型憑證的 client_id
  credentials.installed.client_secret, // 安裝型憑證的 client_secret
  credentials.installed.redirect_uris[0] // 安裝型憑證的 redirect_uris
);
// 設定 LINE bot
const lineConfig = {
  channelAccessToken:
    "JdN/iM6Y21zVqq8cRRwzKIKxsI7lSvOy+9ICm6BYPLH44eVvwqvH8jD7sme95G6+PVs8EshHzm+G3ZtZAcFKu3/uIQpRbHzR5OUuDld6w2fbywQ+hxjoXR+5mzzKjX8NLfNcl/tWs1RRtnG5DC0ldAdB04t89/1O/w1cDnyilFU=", // LINE Bot 的 Access Token
  channelSecret: "89722b4ccd2a4c523ba6438aec517157", // LINE Bot 的 Channel Secret
};
const lineClient = new Client(lineConfig);

const app = express();
const port = 3000;

// 儲存用戶訂單資訊
let userOrders = {};
let allItems = []; // 儲存所有商品資料

// 啟動 Google Sheets API
const sheets = google.sheets("v4");

// 用於授權 Google Sheets
let accessToken = null;

// 連接 Google Sheets 資料
async function getItemsFromSheet() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: "1N9OrHFcqBJraCNIZy5SypP0At1SWKwxhdwScOBc7_S8", // 你的 Google Sheets ID
    range: "Sheet1!A2:B", // 假設品名在 A 列，說明在 B 列
    auth: oAuth2Client,
  });
  const rows = response.data.values;
  allItems = rows || [];
  return rows || [];
}

// 用戶授權後，存取 Google Sheets 資料
app.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  res.redirect(authUrl);
});

// Google Sheets 回調
app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  accessToken = tokens;
  res.send("Authorization successful! You can close this window.");
});

// 設置LINE webhook來接收訊息
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    const replyToken = event.replyToken;
    const userId = event.source.userId;
    const message = event.message;

    if (message.type === "text") {
      // 如果用戶輸入文字，則選擇品項
      if (!userOrders[userId]) {
        const items = await getItemsFromSheet();
        const buttons = items.map((item, index) => ({
          type: "postback",
          label: item[0], // 顯示品名
          data: `item=${index}`, // 傳遞品項索引
        }));

        const carouselTemplate = {
          type: "template",
          altText: "選擇商品",
          template: {
            type: "carousel",
            columns: buttons.map((button) => ({
              title: button.label,
              text: "點選選擇品項",
              actions: [button],
            })),
          },
        };

        await lineClient.replyMessage(replyToken, carouselTemplate);
      } else if (message.type === "postback") {
        // 用戶點擊了品項，記錄品項並要求輸入數量
        const itemIndex = new URLSearchParams(message.data).get("item");
        const items = await getItemsFromSheet();
        const selectedItem = items[itemIndex];

        userOrders[userId] = {
          item: selectedItem[0], // 品名
          description: selectedItem[1], // 說明
          quantity: 0, // 初始化數量
        };

        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: `你選擇了 ${selectedItem[0]} - ${selectedItem[1]}。請輸入數量：`,
        });
      } else {
        // 用戶輸入數量
        if (userOrders[userId]) {
          const quantity = parseInt(message.text, 10);
          if (isNaN(quantity) || quantity <= 0) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "請輸入有效的數量。",
            });
          } else {
            userOrders[userId].quantity = quantity;
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: `訂單已確認：\n品名：${userOrders[userId].item}\n數量：${quantity}`,
            });

            // 總結已訂數量和未定品項
            const orderedItems = [];
            const unselectedItems = [];
            allItems.forEach((item, index) => {
              if (userOrders[userId] && userOrders[userId].item === item[0]) {
                orderedItems.push(
                  `${item[0]} * ${userOrders[userId].quantity}`
                );
              } else {
                unselectedItems.push(item[0]);
              }
            });

            // 回覆已訂品項
            if (orderedItems.length > 0) {
              await lineClient.replyMessage(replyToken, {
                type: "text",
                text: `已訂購品項：\n${orderedItems.join("\n")}`,
              });
            }

            // 回覆未選擇品項
            if (unselectedItems.length > 0) {
              await lineClient.replyMessage(replyToken, {
                type: "text",
                text: `未選擇的品項：\n${unselectedItems.join(", ")}`,
              });
            }

            // 清除訂單
            userOrders[userId] = null;
          }
        }
      }
    }
  }

  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

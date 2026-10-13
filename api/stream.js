"use strict";

const { buildSnapshot } = require("./snapshot");

module.exports = async function handler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    const snap = await buildSnapshot();
    res.write("data: " + JSON.stringify(snap) + "\n\n");
  } catch {}

  // Keep sending periodic updates for ~7 seconds (safe under Vercel hobby 10s limit)
  let count = 0;
  const timer = setInterval(async () => {
    count++;
    if (count >= 3) {
      clearInterval(timer);
      res.end();
      return;
    }
    try {
      const snap = await buildSnapshot();
      res.write("data: " + JSON.stringify(snap) + "\n\n");
    } catch {
      clearInterval(timer);
      res.end();
    }
  }, 2500);

  req.on("close", () => {
    clearInterval(timer);
  });
};

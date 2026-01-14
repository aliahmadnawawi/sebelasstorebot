import { Telegraf } from "telegraf";
import { ensureDefaultProductsOnBoot } from "./seed.js";

import { registerGuard } from "./guard.js";
import { registerMenu } from "./menu.js";
import { registerBalance } from "./balance.js";
import { registerCatalog } from "./catalog.js";
import { registerPayment } from "./payment.js";
import { registerAdmin } from "./admin.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

// urutan penting: guard dulu
registerGuard(bot);

// handlers
registerMenu(bot);
registerBalance(bot);
registerCatalog(bot);
registerPayment(bot);
registerAdmin(bot);

// launch
(async () => {
  await ensureDefaultProductsOnBoot();
  await bot.launch();
  console.log("Bot started");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();

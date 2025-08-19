console.log("Discord Sync Module 2 | BEGIN LOAD");

if (window.__DISCORD_SYNC_2_LOADED__) {
  console.warn("Discord Sync Module 2 | Script already loaded, skipping.");
} else {
  window.__DISCORD_SYNC_2_LOADED__ = true;

  const NS = "discord-sync-module-2";
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  let BASE_URL = null;
  let SYNC_ENDPOINT = null;
  let POLL_ENDPOINT = null;
  let ACK_ENDPOINT = null;

  const POLL_INTERVAL = 10000; // 10s
  let tokenExpiredShown = false;
  let pollInFlight = false;

  // Guard to prevent feedback loops while applying Discord->Foundry updates
  let isApplyingFromDiscord = false;

  class LinkAccountForm extends FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "discord-sync-link-2",
        title: "Link with Discord",
        template: "modules/discord-sync-module-2/templates/ui-panel.html",
        width: 520,
        closeOnSubmit: false,
        resizable: false,
        classes: ["discord-sync-module-2"]
      });
    }

    async getData() {
      const characters = game.actors
        .filter(a => a.type === "character" && !a.folder)
        .map(a => ({ id: a.id, name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const token        = game.settings.get(NS, "discordToken")  || "";
      const actorId      = game.settings.get(NS, "linkedActorId") || "";
      const guildIdWorld = (game.settings.get(NS, "guildIdWorld") || "").trim();
      const baseOverride = (game.settings.get(NS, "adminBaseOverride") || "").trim();

      return {
        token,
        characters,
        selectedActor: actorId,
        guildId: guildIdWorld,
        baseOverride,
        isGM: game.user.isGM
      };
    }

    activateListeners(html) {
      super.activateListeners(html);

      html.find("button.continue").on("click", async ev => {
        ev.preventDefault();
        await this.doSync();
      });

      html.find("button.cancel").on("click", ev => {
        ev.preventDefault();
        this.close();
      });

      html.find("button[name='sync-from-discord']").on("click", async ev => {
        ev.preventDefault();
        await pollForUpdates2(true);
      });

      html.find("form").on("submit", async ev => {
        ev.preventDefault();
        await this.doSync();
      });
    }

    async doSync() {
      try {
        const form    = this.element.find("form");
        const token   = (form.find("input[name=token]").val()?.trim()) || game.settings.get(NS, "discordToken");
        const actorId = form.find("select[name=actor]").val() || game.settings.get(NS, "linkedActorId");

        const guildIdWorld = (game.settings.get(NS, "guildIdWorld") || "").trim();

        if (!token)   return ui.notifications.warn("Please provide a token.");
        if (!actorId) return ui.notifications.warn("Please select a character.");

        if (!guildIdWorld) {
          if (game.user.isGM) {
            return ui.notifications.error(
              "Discord Guild ID is not set. As GM, open Configure Settings → Module Settings → Discord Sync Module 2 and fill in 'Discord Guild ID'."
            );
          } else {
            return ui.notifications.error(
              "Discord Guild ID is not configured on this world. Please ask your GM to set it in Configure Settings."
            );
          }
        }

        if (!/^\d{17,20}$/.test(guildIdWorld)) {
          return ui.notifications.warn("Guild ID must be the numeric Discord snowflake (17–20 digits).");
        }

        await game.settings.set(NS, "discordToken", token);
        await game.settings.set(NS, "linkedActorId", actorId);
        ui.notifications.info("Saved. Syncing…");

        const actor = game.actors.get(actorId);
        if (!actor) return ui.notifications.warn("Selected character not found.");

        const excludedTypes = ["spell", "class", "race", "feat", "background", "subclass", "feature"];

        const payload = {
          token,
          guild_id: String(guildIdWorld),
          character: actor.name,
          gold: actor.system?.currency?.gp ?? 0,
          inventory: actor.items
            .filter(i =>
              !excludedTypes.includes(i.type) &&
              i.name.toLowerCase() !== "unarmed strike"
            )
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)))
            .map(i => ({
              name: i.name,
              qty: typeof i.system?.quantity === "number" ? i.system.quantity : 1,
              type: i.type
            }))
        };

        console.log("Discord Sync 2 | Sending payload:", payload);

        const resp = await fetch(SYNC_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const ct = resp.headers.get("content-type") || "";
        let data = null;
        if (ct.includes("application/json")) { try { data = await resp.json(); } catch {} }
        else { try { data = { raw: await resp.text() }; } catch {} }

        if (resp.ok) {
          ui.notifications.info("Synced successfully!");
          this.close();
          const settingsApp = Object.values(ui.windows ?? {}).find(w => w?.constructor?.name === "SettingsConfig");
          settingsApp?.close();
        } else {
          console.error("Discord Sync 2 | Sync failure:", data ?? {}, resp.status);
          ui.notifications.error(`Sync failed: ${data?.status || `HTTP ${resp.status} — ${data?.raw || ""}`}`);
        }
      } catch (err) {
        console.error("Discord Sync 2 | Exception during sync:", err);
        ui.notifications.error("Sync request error");
      }
    }

    async _updateObject() { /* not used */ }
  }

  Hooks.once("ready", async () => {
    game.settings.register(NS, "dummyVisibleSetting", {
      name: "Enable Discord Sync Module 2",
      hint: "Makes the module appear in settings; no functional effect.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(NS, "discordToken", {
      name: "Discord Link Token",
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    game.settings.register(NS, "linkedActorId", {
      name: "Linked Actor ID",
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    game.settings.register(NS, "guildIdWorld", {
      name: "Discord Guild ID",
      hint: "GM: Enter your Discord Server (Guild) ID (17–20 digit snowflake). All players use this ID automatically.",
      scope: "world",
      config: true,
      type: String,
      default: "",
      onChange: (v) => console.log("Discord Sync 2 | guildIdWorld changed to:", v)
    });

    game.settings.register(NS, "adminBaseOverride", {
      name: "Admin Base URL Override (optional)",
      hint: "Example: https://burberrymarket.dev (leave blank to use the default /discord-sync path on this Foundry origin).",
      scope: "world",
      config: true,
      type: String,
      default: "",
      onChange: (v) => console.log("Discord Sync 2 | adminBaseOverride changed to:", v)
    });

    const override = (game.settings.get(NS, "adminBaseOverride") || "").trim();
    if (override) {
      BASE_URL = override.replace(/\/+$/, "");
    } else {
      BASE_URL = isLocal ? "http://127.0.0.1:8080" : `${window.location.origin}/discord-sync`;
    }
    SYNC_ENDPOINT = `${BASE_URL}/sync`;
    POLL_ENDPOINT = `${BASE_URL}/pending-updates`;
    ACK_ENDPOINT  = `${BASE_URL}/ack-updates`;

    game.settings.registerMenu(NS, "linkMenu", {
      name: "Link with Discord",
      label: "Link Account",
      icon: "fas fa-link",
      type: LinkAccountForm,
      restricted: false
    });

    game.discordSync2 = { openPanel: () => new LinkAccountForm().render(true) };

    // Debounced auto-sync hooks
    Hooks.on("updateActor", debounce(syncToDiscord2, 1000));
    Hooks.on("createItem", debounce(item => syncToDiscord2(item.parent), 1000));
    Hooks.on("updateItem", debounce(item => syncToDiscord2(item.parent), 1000));
    Hooks.on("deleteItem", debounce(item => syncToDiscord2(item.parent), 1000));

    setInterval(pollForUpdates2, POLL_INTERVAL);

    console.log("Discord Sync Module 2 | Initialization complete. BASE_URL:", BASE_URL);
  });

  Hooks.on("getSceneControlButtons", (controls) => {
    try {
      if (!Array.isArray(controls)) return;
      const target = controls.find(c => c.name === "token") ?? controls[0];
      if (!target) return;
      if (!Array.isArray(target.tools)) target.tools = [];

      target.tools.push({
        name: "open-link",
        title: "Link with Discord",
        icon: "fas fa-link",
        button: true,
        onClick: () => game.discordSync2?.openPanel(),
        visible: true
      });
    } catch (e) {
      console.warn("Discord Sync 2 | Failed to add scene tool button:", e);
    }
  });

  async function pollForUpdates2(manual = false) {
    const token        = game.settings.get(NS, "discordToken");
    const actorId      = game.settings.get(NS, "linkedActorId");
    const guildIdWorld = (game.settings.get(NS, "guildIdWorld") || "").trim();

    if (!token || !actorId || !guildIdWorld) {
      if (manual) ui.notifications.warn("Link your token, actor, and set a Guild ID first.");
      return;
    }

    if (pollInFlight) {
      console.debug("Discord Sync 2 | Poll skipped (in flight)");
      return;
    }

    pollInFlight = true;
    console.log("Discord Sync 2 | Polling (peek)", { token: token.slice(0, 8) + "…", actorId, guildIdWorld, POLL_ENDPOINT });

    try {
      // PEEK: non-destructive fetch
      const url = `${POLL_ENDPOINT}?token=${encodeURIComponent(token)}&guild_id=${encodeURIComponent(guildIdWorld)}&peek=1`;
      const resp = await fetch(url);

      // NEW: handle 401 (expired token / sliding TTL)
      if (resp.status === 401 && !tokenExpiredShown) {
        tokenExpiredShown = true;
        let msg = "Your sync token has expired. Please re-link with /linkfoundry in Discord.";
        try {
          const j = await resp.json();
          if (j?.status) msg = `Discord Sync: ${j.status}. Please re-link with /linkfoundry.`;
        } catch {}
        new Dialog({
          title: "⚠️ Discord Sync Token",
          content: `<p>${msg}</p>`,
          buttons: { ok: { icon: "<i class='fas fa-check'></i>", label: "OK" } }
        }).render(true);
        // small backoff to avoid log spam
        await new Promise(r => setTimeout(r, 15000));
        return;
      }

      if (resp.status === 400) {
        const result = await resp.json().catch(() => ({}));
        if (result.status === "invalid token" && !tokenExpiredShown) {
          tokenExpiredShown = true;
          new Dialog({
            title: "⚠️ Discord Sync Error",
            content: `<p><strong>Your sync token has expired or is invalid.</strong><br>Please re-link your character using <code>/linkfoundry</code> in Discord.</p>`,
            buttons: { ok: { icon: "<i class='fas fa-check'></i>", label: "OK" } }
          }).render(true);
        }
        return;
      }

      const ct = resp.headers.get("content-type") || "";
      const result = ct.includes("application/json") ? await resp.json() : { status: "error", raw: await resp.text() };

      if (result.status !== "success") {
        if (manual) ui.notifications.warn(`Sync from Discord failed: ${result.status || "Unknown error"}`);
        return;
      }

      const updates = result.updates;
      if (!Array.isArray(updates) || updates.length === 0) {
        if (manual) ui.notifications.info("No pending updates from Discord.");
        return;
      }

      const actor = game.actors.get(actorId);
      if (!actor) {
        console.warn(`Discord Sync 2 | Actor '${actorId}' not found.`);
        if (manual) ui.notifications.error("Linked Actor not found.");
        return;
      }

      // Apply all updates atomically, then ACK only those that succeeded
      isApplyingFromDiscord = true;
      let appliedIds = [];
      let updated = false;

      try {
        for (const update of updates) {
          const upId = String(update.id || ""); // may be empty if something went wrong server-side
          const ok = await applyOneUpdate(actor, update);
          if (ok) {
            updated = true;
            if (upId) appliedIds.push(upId);
          } else {
            console.warn("Discord Sync 2 | Skipped/failed update (not acked):", update);
          }
        }
      } finally {
        isApplyingFromDiscord = false;
      }

      // ACK only after success
      if (appliedIds.length > 0) {
        try {
          const ackResp = await fetch(ACK_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, guild_id: String(guildIdWorld), ids: appliedIds })
          });
          const ackJson = await ackResp.json().catch(() => ({}));
          if (!ackResp.ok) {
            console.warn("Discord Sync 2 | ACK failed:", ackJson);
          } else {
            console.log("Discord Sync 2 | ACKed updates:", ackJson);
          }
        } catch (e) {
          console.warn("Discord Sync 2 | ACK request error:", e);
        }
      }

      if (updated) {
        // After ALL updates have been applied, now do a single authoritative sync to server
        await syncToDiscord2(actor, /*force*/ true);
        ui.notifications.info("Applied updates from Discord.");
        console.log("Discord Sync 2 | New updates applied from Discord (batched + acked).");
      } else if (manual) {
        ui.notifications.info("No applicable updates.");
      }
    } catch (err) {
      console.warn("Discord Sync 2 | Poll failed:", err);
      if (manual) ui.notifications.error("Polling failed. Check console for details.");
    } finally {
      pollInFlight = false;
    }
  }

  async function applyOneUpdate(actor, update) {
    try {
      // --- Purchase envelope (server-side batch) ---
      if (update.type === "purchase") {
        const items = Array.isArray(update.items_added) ? update.items_added : [];
        for (const item of items) {
          await upsertItemFromCompendiumOrCreate(actor, item);
        }
        if (update.gold_delta !== undefined && update.gold_delta !== null) {
          const delta = Number(update.gold_delta) || 0;
          const gp = Number(foundry.utils.getProperty(actor.system, "currency.gp") || 0);
          await actor.update({ "system.currency.gp": gp + delta });
        }
        return true;
      }

      // --- Optional: batch add items ---
      if (update.action === "addItems" && Array.isArray(update.items)) {
        for (const it of update.items) {
          await upsertItemFromCompendiumOrCreate(actor, it);
        }
        return true;
      }

    // --- Atomic actions the bot usually enqueues ---
    // Accept BOTH shapes:
    // 1) { action:"addItem", item:{name, qty, type} }
    // 2) { action:"addItem", name, qty, type }
    if (update.action === "addItem") {
      const it = update.item || (
        update.name ? {
          name: String(update.name),
          qty: Math.max(1, Number(update.qty || 1)),   // ← ensure >= 1
          type: update.type || "loot"                  // dnd5e uses "loot" for generic stuff
        } : null
      );
      if (it && it.name) {
        await upsertItemFromCompendiumOrCreate(actor, it);
        console.log(`Discord Sync 2 | addItem: ${it.name} x${it.qty}`);
        return true;
      }
    }



      if (update.action === "deductGP" && update.amount !== undefined) {
        const amt = Math.max(0, Number(update.amount) || 0);
        const currentGP = Number(foundry.utils.getProperty(actor.system, "currency.gp") || 0);
        await actor.update({ "system.currency.gp": Math.max(0, currentGP - amt) });
        return true;
      }

      if (update.action === "addGP" && update.amount !== undefined) {
        const amt = Number(update.amount) || 0;
        const currentGP = Number(foundry.utils.getProperty(actor.system, "currency.gp") || 0);
        await actor.update({ "system.currency.gp": currentGP + amt });
        return true;
      }

      if (update.action === "setGP" && update.amount !== undefined) {
        const amt = Math.max(0, Number(update.amount) || 0);
        await actor.update({ "system.currency.gp": amt });
        console.log(`💰 Set GP to ${amt}`);
        return true;
      }

      if (update.action === "clearInventory") {
      // keep non-inventory documents (spells, class, features, etc.)
      const INV_TYPES = new Set(["weapon","equipment","consumable","tool","loot","backpack","container","ammo","ammunition"]);
      const ids = actor.items.filter(i => INV_TYPES.has(i.type)).map(i => i.id);
      if (ids.length) {
        await actor.deleteEmbeddedDocuments("Item", ids);
        console.log(`Discord Sync 2 | Cleared ${ids.length} inventory item(s).`);
      } else {
        console.log("Discord Sync 2 | Inventory clear: nothing to delete.");
      }
      return true;
    }


      if (update.action === "test") {
        console.log("Discord Sync 2 | Received test update:", update);
        ui.notifications.info("Received test update from Discord (Module 2).");
        return true;
      }

      // Support both snake_case and camelCase remove
      if ((update.action === "remove_item" || update.action === "removeItem") && update.name) {
        const qty = Number(update.qty || 1);
        const it = actor.items.find(i => i.name.toLowerCase() === String(update.name).toLowerCase());
        if (it) {
          const currentQty = Number(it.system?.quantity ?? 1);
          const newQty = currentQty - qty;
          if (newQty > 0) {
            await it.update({ "system.quantity": newQty });
          } else {
            await it.delete();
          }
          console.log(`🗑️ Removed ${qty} of ${update.name} from actor.`);
          return true;
        } else {
          console.warn(`⚠️ Tried to remove item '${update.name}', but it was not found.`);
          return false;
        }
      }

      // unknown update type
      console.warn("Discord Sync 2 | Unknown update shape:", update);
      return false;
    } catch (e) {
      console.error("Discord Sync 2 | Failed applying update:", update, e);
      return false;
    }
  }

  async function upsertItemFromCompendiumOrCreate(actor, itemData) {
    if (!itemData) return;
    const name = String(itemData.name || "").trim();
    const qty  = Number(itemData.qty || 1);
    const type = itemData.type || "loot";
    if (!name) return;

    const existing = actor.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing && typeof existing.system?.quantity === "number") {
      await existing.update({ "system.quantity": (existing.system.quantity || 0) + qty });
      console.log(`🟡 Updated quantity for existing item: ${name}`);
      return;
    }

    let docObj = null;
    try {
      const compendium = game.packs.get("dnd5e.items");
      if (compendium) {
        const index = await compendium.getIndex();
        const entry = index.find(e => e.name.toLowerCase() === name.toLowerCase());
        if (entry) {
          const document = await compendium.getDocument(entry._id);
          docObj = document.toObject();
          docObj.system = docObj.system || {};
          // FIX: set exact requested quantity on first import (avoid compendium's base 1 + purchased qty)
          docObj.system.quantity = Number(qty) || 1;
          console.log(`✅ Imported ${name} from compendium.`);
        }
      }
    } catch (err) {
      console.warn(`❌ Error searching compendium for ${name}:`, err);
    }

    if (!docObj) {
      docObj = { name, type, system: { quantity: qty } };
      console.log(`🛠️ Created custom item: ${name}`);
    }

    try {
      await actor.createEmbeddedDocuments("Item", [docObj]);
    } catch (err) {
      console.error(`❌ Failed to create item '${name}'`, err);
    }
  }

  function debounce(func, delay) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), delay);
    };
  }

  // force param lets us bypass the guard for the final post-apply sync
  async function syncToDiscord2(actor, force = false) {
    if (!actor) return;

    // Skip automatic syncs triggered by Foundry hooks while applying polled updates
    if (isApplyingFromDiscord && !force) return;

    const token        = game.settings.get(NS, "discordToken");
    const actorId      = game.settings.get(NS, "linkedActorId");
    const guildIdWorld = (game.settings.get(NS, "guildIdWorld") || "").trim();

    if (!token || !actorId || !guildIdWorld || actor.id !== actorId) return;

    const excludedTypes = ["spell", "class", "race", "feat", "background", "subclass", "feature"];

    const payload = {
      token,
      guild_id: String(guildIdWorld),
      character: actor.name,
      gold: actor.system?.currency?.gp ?? 0,
      inventory: actor.items
        .filter(i =>
          !excludedTypes.includes(i.type) &&
          i.name.toLowerCase() !== "unarmed strike"
        )
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)))
        .map(i => ({
          name: i.name,
          qty: typeof i.system?.quantity === "number" ? i.system.quantity : 1,
          type: i.type
        }))
    };

    console.log("Discord Sync 2 | Syncing to server:", payload, { force, isApplyingFromDiscord });

    try {
      await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn("Discord Sync 2 | Sync error:", err);
    }
  }

  // handy exports for console debugging
  window.pollForUpdates2 = pollForUpdates2;
  window.getLinkedActorId2 = () => game.settings.get(NS, "linkedActorId");
  window.syncToDiscord2 = syncToDiscord2;

}

console.log("Discord Sync Module 2 | BEGIN LOAD");

// Per-namespace load guard so dev & non-dev can coexist
window.__DISCORD_SYNC_2_LOADED__ = window.__DISCORD_SYNC_2_LOADED__ || {};

// ===== Force namespace to match module.json id =====
const NS = "discord-sync-module-2";
window.DISCORD_SYNC_NS = NS; // for console debugging

if (window.__DISCORD_SYNC_2_LOADED__[NS]) {
  console.warn(`Discord Sync Module 2 | Script already loaded for '${NS}', skipping.`);
} else {
  window.__DISCORD_SYNC_2_LOADED__[NS] = true;

  // --- shared vars (used by ready/poller) ---
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  let BASE_URL = null;
  let SYNC_ENDPOINT = null;
  let POLL_ENDPOINT = null;
  let ACK_ENDPOINT = null;

  // Poll cadence + timeouts
  const POLL_INTERVAL = 4000;
  const POLL_TIMEOUT_MS = 4000;
  const RETRY_MIN_MS = 500;
  const RETRY_MAX_MS = 1500;

  let tokenExpiredShown = false;
  let pollInFlight = false;

  // Guard to prevent feedback loops while applying Discord->Foundry updates
  let isApplyingFromDiscord = false;

  let syncInFlight = false;   // ADD
  let syncQueued   = false;   // ADD
  let lastSyncAt   = 0;       // ADD

  // ---------- small helpers ----------
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function _jitter() {
    return Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1)) + RETRY_MIN_MS;
  }

  // =========================
  // System detection + adapters
  // =========================
  function getActiveSystem() {
    const pref = (game.settings.get(NS, "systemOverride") || "auto");
    if (pref !== "auto") return pref;
    return game.system?.id || "dnd5e";
  }

  // --------- Coin helpers ----------
  // D&D 5e uses pp/gp/ep/sp/cp
  function toCopper5e({pp=0,gp=0,ep=0,sp=0,cp=0}={}) {
    return (Number(pp)||0)*1000 + (Number(gp)||0)*100 + (Number(ep)||0)*50 + (Number(sp)||0)*10 + (Number(cp)||0);
  }
  function fromCopper5e(totalCp) {
    totalCp = Math.max(0, Math.floor(Number(totalCp)||0));
    const pp = Math.floor(totalCp / 1000); totalCp %= 1000;
    const gp = Math.floor(totalCp / 100);  totalCp %= 100;
    const ep = Math.floor(totalCp / 50);   totalCp %= 50;
    const sp = Math.floor(totalCp / 10);   totalCp %= 10;
    const cp = totalCp;
    return { pp, gp, ep, sp, cp };
  }

  // PF1e/PF2e use pp/gp/sp/cp (no ep)
  function toCopperPF({pp=0,gp=0,sp=0,cp=0}={}) {
    return (Number(pp)||0)*1000 + (Number(gp)||0)*100 + (Number(sp)||0)*10 + (Number(cp)||0);
  }
  function fromCopperPF(totalCp) {
    totalCp = Math.max(0, Math.floor(Number(totalCp)||0));
    const pp = Math.floor(totalCp / 1000); totalCp %= 1000;
    const gp = Math.floor(totalCp / 100);  totalCp %= 100;
    const sp = Math.floor(totalCp / 10);   totalCp %= 10;
    const cp = totalCp;
    return { pp, gp, sp, cp };
  }

    // ------- Adapters (dnd5e / pf1 / pf2e) -------
  const Adapters = {
    // ======= D&D 5e (full coin system with EP) =======
    dnd5e: {
      readGP(actor) {
        const get = foundry.utils.getProperty;
        const pp = Number(get(actor.system, "currency.pp") ?? 0);
        const gp = Number(get(actor.system, "currency.gp") ?? 0);
        const ep = Number(get(actor.system, "currency.ep") ?? 0);
        const sp = Number(get(actor.system, "currency.sp") ?? 0);
        const cp = Number(get(actor.system, "currency.cp") ?? 0);
        const totalCp = toCopper5e({ pp, gp, ep, sp, cp });
        return totalCp / 100;
      },

      async addGP(actor, delta) {
        delta = Number(delta || 0);
        if (!delta) return;

        const get = foundry.utils.getProperty;
        const cur = {
          pp: Number(get(actor.system, "currency.pp") ?? 0),
          gp: Number(get(actor.system, "currency.gp") ?? 0),
          ep: Number(get(actor.system, "currency.ep") ?? 0),
          sp: Number(get(actor.system, "currency.sp") ?? 0),
          cp: Number(get(actor.system, "currency.cp") ?? 0),
        };

        const currentCp = toCopper5e(cur);
        const newCp = Math.max(0, currentCp + Math.round(delta * 100));
        const norm = fromCopper5e(newCp);
        await actor.update({
          "system.currency.pp": norm.pp,
          "system.currency.gp": norm.gp,
          "system.currency.ep": norm.ep,
          "system.currency.sp": norm.sp,
          "system.currency.cp": norm.cp
        });
      },

      async setGP(actor, amount) {
        amount = Math.max(0, Number(amount || 0));
        const gp = Math.floor(amount);
        const frac = amount - gp;
        const sp = Math.floor(frac * 10);
        const cp = Math.round((frac * 10 - sp) * 10);
        await actor.update({
          "system.currency.pp": 0,
          "system.currency.gp": gp,
          "system.currency.ep": 0,
          "system.currency.sp": sp,
          "system.currency.cp": cp
        });
      },

      isSpell(doc) { return doc.type === "spell"; },
      getQty(doc)  { return typeof doc.system?.quantity === "number" ? doc.system.quantity : 1; },
      qtyPath: "system.quantity",
      packs: ["dnd5e.items"]
    },


    // ======= Pathfinder 1e (pp/gp/sp/cp) =======
    pf1: {
      readGP(actor) {
        const get = foundry.utils.getProperty;
        const pp = Number(get(actor.system, "currency.pp") ?? 0);
        const gp = Number(get(actor.system, "currency.gp") ?? 0);
        const sp = Number(get(actor.system, "currency.sp") ?? 0);
        const cp = Number(get(actor.system, "currency.cp") ?? 0);
        const totalCp = toCopperPF({ pp, gp, sp, cp });
        return totalCp / 100;
      },

      async addGP(actor, delta) {
        delta = Number(delta || 0);
        if (!delta) return;

        const get = foundry.utils.getProperty;
        const cur = {
          pp: Number(get(actor.system, "currency.pp") ?? 0),
          gp: Number(get(actor.system, "currency.gp") ?? 0),
          sp: Number(get(actor.system, "currency.sp") ?? 0),
          cp: Number(get(actor.system, "currency.cp") ?? 0),
        };

        const currentCp = toCopperPF(cur);
        const newCp = Math.max(0, currentCp + Math.round(delta * 100));
        const norm = fromCopperPF(newCp);
        await actor.update({
          "system.currency.pp": norm.pp,
          "system.currency.gp": norm.gp,
          "system.currency.sp": norm.sp,
          "system.currency.cp": norm.cp
        });
      },

      async setGP(actor, amount) {
        amount = Math.max(0, Number(amount || 0));
        const gp = Math.floor(amount);
        const frac = amount - gp;
        const sp = Math.floor(frac * 10);
        const cp = Math.round((frac * 10 - sp) * 10);
        await actor.update({
          "system.currency.pp": 0,
          "system.currency.gp": gp,
          "system.currency.sp": sp,
          "system.currency.cp": cp
        });
      },

      isSpell(doc) { return doc.type === "spell"; },
      getQty(doc)  { return typeof doc.system?.quantity === "number" ? doc.system.quantity : 1; },
      qtyPath: "system.quantity",
      packs: ["pf1.items"]
    },

    // ===== PF2E (pp/gp/sp/cp) — purse OR coin items (name-aware) =====
    pf2e: {
      _getNum(v) { return Number(v?.value ?? v ?? 0); },

      _readSystemPurse(actor) {
        const get = foundry.utils.getProperty;
        const candidates = [
          "system.wealth.coinage",
          "system.currency",
          "system.currencies",
          "system.treasury.coinage",
          "system.resources.coinage"
        ];
        for (const path of candidates) {
          const c = get(actor, path);
          if (c && typeof c === "object") {
            const pp = this._getNum(c.pp);
            const gp = this._getNum(c.gp);
            const sp = this._getNum(c.sp);
            const cp = this._getNum(c.cp);
            if (["pp","gp","sp","cp"].some(k => k in c)) {
              return { kind: "purse", path, coins: { pp, gp, sp, cp } };
            }
          }
        }
        return null;
      },

      _readCoinItems(actor) {
        const coins = { pp:0, gp:0, sp:0, cp:0 };
        const items = actor.items ?? [];

        const nameToDenom = (name) => {
          const n = String(name || "").toLowerCase().trim();
          if (/^(pp\b|.*\bplat(ina|inum)?\b)/.test(n)) return "pp";
          if (/^(gp\b|.*\bgold\b)/.test(n)) return "gp";
          if (/^(sp\b|.*\bsilver\b)/.test(n)) return "sp";
          if (/^(cp\b|.*\bcopper\b)/.test(n)) return "cp";
          return null;
        };

        const readQty = (sys) => {
          const cands = [
            sys?.quantity, sys?.quantity?.value,
            sys?.stackSize,
            sys?.value, sys?.amount, sys?.count,
            sys?.q, sys?.q?.value
          ];
          for (const v of cands) {
            const n = Number(v);
            if (!Number.isNaN(n)) return n;
          }
          return 0;
        };

        let seen = false;

        for (const it of items) {
          try {
            if (it.type !== "treasure") continue;

            // Explicit coin stack
            const sg  = it.system?.stackGroup;
            const den = String(it.system?.denomination || "").toLowerCase();
            if (sg === "coins" && ["pp","gp","sp","cp"].includes(den)) {
              coins[den] = (coins[den] || 0) + Math.max(0, readQty(it.system));
              seen = true;
              continue;
            }

            // Name-based coin stack (e.g., "Gold Pieces")
            const byName = nameToDenom(it.name);
            if (byName) {
              coins[byName] = (coins[byName] || 0) + Math.max(0, readQty(it.system));
              seen = true;
            }
          } catch {}
        }

        return seen ? { kind: "items", coins } : null;
      },

      _readCoins(actor) {
        return this._readSystemPurse(actor) || this._readCoinItems(actor) || { kind:"none", coins:{pp:0,gp:0,sp:0,cp:0} };
      },

      async _writeCoins(actor, source, coins) {
        if (source?.kind === "purse") {
          const cur = foundry.utils.getProperty(actor, source.path) || {};
          const valueObj = ["pp","gp","sp","cp"].every(k => cur[k] && typeof cur[k] === "object" && ("value" in cur[k]));
          const payload = {};
          if (valueObj) {
            payload[`${source.path}.pp.value`] = coins.pp;
            payload[`${source.path}.gp.value`] = coins.gp;
            payload[`${source.path}.sp.value`] = coins.sp;
            payload[`${source.path}.cp.value`] = coins.cp;
          } else {
            payload[`${source.path}.pp`] = coins.pp;
            payload[`${source.path}.gp`] = coins.gp;
            payload[`${source.path}.sp`] = coins.sp;
            payload[`${source.path}.cp`] = coins.cp;
          }
          await actor.update(payload);
          return;
        }

        // Items route
        const denomKeys = ["pp","gp","sp","cp"];
        const items = actor.items ?? [];
        const nameFor = { pp: "Platinum Pieces", gp: "Gold Pieces", sp: "Silver Pieces", cp: "Copper Pieces" };

        const nameToDenom = (name) => {
          const n = String(name || "").toLowerCase().trim();
          if (/^(pp\b|.*\bplat(ina|inum)?\b)/.test(n)) return "pp";
          if (/^(gp\b|.*\bgold\b)/.test(n)) return "gp";
          if (/^(sp\b|.*\bsilver\b)/.test(n)) return "sp";
          if (/^(cp\b|.*\bcopper\b)/.test(n)) return "cp";
          return null;
        };

        const qtyPathOf = (sys) => {
          if (Object.prototype.hasOwnProperty.call(sys||{}, "quantity")) return "system.quantity";
          if (Object.prototype.hasOwnProperty.call(sys||{}, "stackSize")) return "system.stackSize";
          if (Object.prototype.hasOwnProperty.call(sys||{}, "value")) return "system.value";
          if (Object.prototype.hasOwnProperty.call(sys||{}, "amount")) return "system.amount";
          if (Object.prototype.hasOwnProperty.call(sys||{}, "count")) return "system.count";
          if (Object.prototype.hasOwnProperty.call(sys||{}, "q")) return "system.q";
          return "system.quantity";
        };

        // Map existing coin stacks by denom
        const byDenom = Object.create(null);
        for (const it of items) {
          if (it.type !== "treasure") continue;
          const den = (it.system?.stackGroup === "coins" && ["pp","gp","sp","cp"].includes(String(it.system?.denomination||"").toLowerCase()))
            ? String(it.system?.denomination).toLowerCase()
            : nameToDenom(it.name);
          if (den && !byDenom[den]) byDenom[den] = it;
        }

        const updates = [];
        const creates = [];

        for (const den of denomKeys) {
          const targetQty = Math.max(0, Number(coins[den]||0));
          const ex = byDenom[den];
          if (ex) {
            const path = qtyPathOf(ex.system);
            const cur  = Number(ex.system?.quantity ?? ex.system?.stackSize ?? ex.system?.value ?? ex.system?.amount ?? ex.system?.count ?? ex.system?.q ?? 0);
            if (cur !== targetQty) {
              const u = { _id: ex.id };
              u[path] = targetQty;
              updates.push(u);
            }
          } else if (targetQty > 0) {
            creates.push({
              name: nameFor[den],
              type: "treasure",
              system: {
                stackGroup: "coins",
                denomination: den,
                quantity: targetQty
              }
            });
          }
        }

        if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
        if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
      },

      readGP(actor) {
        const { coins } = this._readCoins(actor);
        const totalCp = (coins.pp*1000) + (coins.gp*100) + (coins.sp*10) + (coins.cp);
        return totalCp / 100;
      },

      async addGP(actor, delta) {
        delta = Number(delta || 0);
        if (!delta) return;

        const source = this._readCoins(actor);
        const coins  = source.coins || { pp:0, gp:0, sp:0, cp:0 };
        const currentCp = (coins.pp*1000) + (coins.gp*100) + (coins.sp*10) + (coins.cp);
        const newCp = Math.max(0, currentCp + Math.round(delta * 100));

        let rem = newCp;
        const pp = Math.floor(rem / 1000); rem %= 1000;
        const gp = Math.floor(rem / 100);  rem %= 100;
        const sp = Math.floor(rem / 10);   rem %= 10;
        const cp = rem;

        await this._writeCoins(actor, source.kind === "none" ? {kind:"items"} : source, { pp, gp, sp, cp });
      },

      async setGP(actor, amount) {
        amount = Math.max(0, Number(amount || 0));
        const gp = Math.floor(amount);
        const frac = amount - gp;
        const sp = Math.floor(frac * 10);
        const cp = Math.round((frac * 10 - sp) * 10);

        const source = this._readCoins(actor);
        await this._writeCoins(actor, source.kind === "none" ? {kind:"items"} : source, { pp:0, gp, sp, cp });
      },

      isSpell(doc) { return doc.type === "spell"; },
      getQty(doc)  { return typeof doc.system?.quantity === "number" ? doc.system.quantity : 1; },
      qtyPath: "system.quantity",
      packs: ["pf2e.equipment-srd","pf2e.adventuring-gear"]
    }
  };

  function A() {
    const sys = getActiveSystem();
    return Adapters[sys] || Adapters.dnd5e;
  }

  // === Physical / tradable items per system ===
  function getPhysicalTypeSet() {
    const sys = (getActiveSystem() || "").toLowerCase();
    switch (sys) {
      case "pf2e":
        return new Set(["weapon","armor","shield","equipment","consumable","backpack","treasure","ammunition","kit"]);
      case "pf1":
        return new Set(["weapon","armor","shield","equipment","consumable","loot","container","tool","ammo"]);
      case "dnd5e":
      default:
        return new Set(["weapon","armor","shield","equipment","consumable","tool","loot","container","backpack","ammo"]);
    }
  }

  function buildInventoryForPayload(actor) {
    const keep = getPhysicalTypeSet();
    const adapter = A();
    return actor.items
      .filter(i => keep.has(String(i.type || "").toLowerCase()))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)))
      .map(i => ({
        name: i.name,
        qty: adapter.getQty(i),
        type: i.type
      }));
  }

  // ------- Link dialog -------
  class LinkAccountForm extends FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "discord-sync-link-2",
        title: "Link with Discord",
        template: `modules/${NS}/templates/ui-panel.html`,
        width: 520,
        closeOnSubmit: false,
        resizable: false,
        classes: [NS]
      });
    }

    async getData() {
      const characters = game.actors
        .filter(a => a.type === "character")
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

      html.find("button[name='push-to-discord']").on("click", async ev => {
        ev.preventDefault();
        const actorId = game.settings.get(NS, "linkedActorId");
        const actor = actorId ? game.actors.get(actorId) : null;
        if (!actor) return ui.notifications.warn("Linked Actor not found.");
        await syncToDiscord2(actor, /*force*/ true);
        ui.notifications.info("Pushed current gold & inventory to Discord.");
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

        const adapter = A();

        const payload = {
          token,
          guild_id: String(guildIdWorld),
          character: actor.name,
          gold: adapter.readGP(actor),
          inventory: buildInventoryForPayload(actor)
        };

        // Mask token in log
        const _mask = t => (t ? String(t).slice(0, 8) + "…" : t);
        console.log("Discord Sync 2 | Sending payload:", { ...payload, token: _mask(payload.token) });

        const resp = await fetch(SYNC_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify(payload)
        });

        const ct = resp.headers.get("content-type") || "";
        let bodyText = null, bodyJson = null;
        try { bodyText = await resp.clone().text(); } catch {}
        try { bodyJson = ct.includes("application/json") ? JSON.parse(bodyText || "{}") : null; } catch {}

        console.log("Discord Sync 2 | /sync response", {
          ok: resp.ok, status: resp.status, headers: Object.fromEntries(resp.headers.entries() ),
          bodyText, bodyJson
        });

        if (resp.ok) {
          ui.notifications.info("Synced successfully!");
          this.close();
          const settingsApp = Object.values(ui.windows ?? {}).find(w => w?.constructor?.name === "SettingsConfig");
          settingsApp?.close();
        } else {
          const msg = bodyJson?.status || bodyJson?.message || bodyText || `HTTP ${resp.status}`;
          console.error("Discord Sync 2 | Sync failure:", msg);
          ui.notifications.error(`Sync failed: ${msg}`);
        }
      } catch (err) {
        console.error("Discord Sync 2 | Exception during sync:", err);
        ui.notifications.error("Sync request error");
      }
    }

    async _updateObject() { /* not used */ }
  }

  // ------- Settings registration -------
  function registerSettingsFor(ns) {
    try {
      game.settings.register(ns, "dummyVisibleSetting", {
        name: "Enable Discord Sync Module 2",
        hint: "Makes the module appear in settings; no functional effect.",
        scope: "client",
        config: true,
        type: Boolean,
        default: true
      });

      game.settings.register(ns, "discordToken", {
        name: "Discord Link Token",
        scope: "client",
        config: false,
        type: String,
        default: ""
      });

      game.settings.register(ns, "linkedActorId", {
        name: "Linked Actor ID",
        scope: "client",
        config: false,
        type: String,
        default: ""
      });

      game.settings.register(ns, "guildIdWorld", {
        name: "Discord Guild ID",
        hint: "GM: Enter your Discord Server (Guild) ID (17–20 digit snowflake). All players use this ID automatically.",
        scope: "world",
        config: true,
        type: String,
        default: "",
        onChange: (v) => console.log("Discord Sync 2 | guildIdWorld changed to:", v)
      });

      game.settings.register(ns, "systemOverride", {
        name: "Game System",
        hint: "Choose which TTRPG system this world uses. 'Auto' detects from the world (game.system.id).",
        scope: "world",
        config: true,
        type: String,
        choices: {
          auto: "Auto (detect from world)",
          dnd5e: "D&D 5e",
          pf2e: "Pathfinder 2e",
          pf1: "Pathfinder 1e"
        },
        default: "auto",
        onChange: (v) => console.log("Discord Sync 2 | systemOverride changed to:", v)
      });

      game.settings.register(ns, "adminBaseOverride", {
        name: "Admin Base URL Override (optional)",
        hint: "Example: https://burberrymarket.dev (leave blank to use the default /discordsync path).",
        scope: "world",
        config: true,
        type: String,
        default: "",
        onChange: (v) => console.log("Discord Sync 2 | adminBaseOverride changed to:", v)
      });

      game.settings.registerMenu(ns, "linkMenu", {
        name: "Link with Discord",
        label: "Link Account",
        icon: "fas fa-link",
        type: LinkAccountForm,
        restricted: false
      });

      console.log(`Discord Sync 2 | Registered settings for namespace '${ns}'`);
    } catch (e) {
      console.warn(`Discord Sync 2 | Failed registering settings for '${ns}':`, e);
    }
  }

  // --- Register settings EARLY so they appear in Configure Settings ---
  Hooks.once("init", () => {
    try {
      registerSettingsFor(NS);
      console.log(`Discord Sync 2 | Settings registered for '${NS}' on init`);
    } catch (e) {
      console.error("Discord Sync 2 | Settings registration failed on init:", e);
    }
  });

  // --- Main startup (endpoints, buttons, hooks, polling) ---
  Hooks.once("ready", async () => {
    try {
      // Prefer admin override if set; otherwise default to our public reverse-proxied base.
      const override = (game.settings.get(NS, "adminBaseOverride") || "").trim();
      const DEFAULT_PUBLIC_BASE = "https://burberrymarket.dev/discordsync";
      const normalizeBase = (u) => String(u || "").replace(/\/+$/, "");

      BASE_URL = normalizeBase(override || DEFAULT_PUBLIC_BASE);
      SYNC_ENDPOINT = `${BASE_URL}/sync`;
      POLL_ENDPOINT = `${BASE_URL}/pending-updates`;
      ACK_ENDPOINT  = `${BASE_URL}/ack-updates`;

      // Add toolbar buttons (token controls)
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
            onClick: () => new LinkAccountForm().render(true),
            visible: true
          });

          target.tools.push({
            name: "push-to-discord",
            title: "Push to Discord (Gold & Inventory)",
            icon: "fas fa-cloud-upload-alt",
            button: true,
            onClick: async () => {
              const actorId = game.settings.get(NS, "linkedActorId");
              const actor = actorId ? game.actors.get(actorId) : null;
              if (!actor) return ui.notifications.warn("Linked Actor not found.");
              await syncToDiscord2(actor, /*force*/ true);
              ui.notifications.info("Pushed current gold & inventory to Discord.");
            },
            visible: true
          });
        } catch (e) {
          console.warn("Discord Sync 2 | Failed to add scene tool button:", e);
        }
      });

      // Debounced auto-sync hooks
      Hooks.on("updateActor", debounce(syncToDiscord2, 1000));
      Hooks.on("createItem", debounce(item => syncToDiscord2(item.parent), 1000));
      Hooks.on("updateItem", debounce(item => syncToDiscord2(item.parent), 1000));
      Hooks.on("deleteItem", debounce(item => syncToDiscord2(item.parent), 1000));

      setInterval(pollForUpdates2, POLL_INTERVAL);

      console.log(
        "Discord Sync Module 2 | Initialization complete. BASE_URL:",
        BASE_URL, "System:", getActiveSystem(), "NS:", NS
      );
    } catch (e) {
      console.error("Discord Sync 2 | Startup error:", e);
    }
  });

  // ===== Functions that rely on the above scoped vars (keep inside guard) =====

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
    console.log("Discord Sync 2 | Polling", { token: token.slice(0, 8) + "…", actorId, guildIdWorld, POLL_ENDPOINT });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("poll-timeout")), POLL_TIMEOUT_MS);

    try {
      const url = `${POLL_ENDPOINT}?token=${encodeURIComponent(token)}&guild_id=${encodeURIComponent(guildIdWorld)}`;
      const resp = await fetch(url, {
        method: "GET",
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal
      });

      if (resp.status === 204) {
        if (manual) ui.notifications.info("No pending updates from Discord.");
        return;
      }

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

      isApplyingFromDiscord = true;
      let appliedIds = [];
      let updated = false;

      try {
        for (const update of updates) {
          const upId = String(update.id || "");
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

      if (appliedIds.length > 0) {
        try {
          const ackResp = await fetch(ACK_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            body: JSON.stringify({ token, guild_id: String(guildIdWorld), ids: appliedIds })
          });
          const ackJson = await ackResp.json().catch(() => ({}));
          if (!ackResp.ok) {
            console.warn("Discord Sync 2 | ACK failed:", ackJson);
          } else {
            console.log("Discord Sync 2 | ACKed updates:", ackJson);
          }
        } catch (e) {
          console.warn("Discord Sync  2 | ACK request error:", e);
        }
      }

      if (updated) {
        await syncToDiscord2(actor, /*force*/ true);
        ui.notifications.info("Applied updates from Discord.");
        console.log("Discord Sync 2 | New updates applied from Discord (batched + acked).");
      } else if (manual) {
        ui.notifications.info("No applicable updates.");
      }
    } catch (err) {
      console.warn("Discord Sync 2 | Poll failed:", err?.message || err);
      if (err?.name === "AbortError" || /poll-timeout/.test(String(err?.message || "")) || err?.code === "ETIMEDOUT") {
        const delay = _jitter();
        console.debug(`Discord Sync 2 | Poll timed out; retrying in ${delay}ms`);
        setTimeout(() => { pollForUpdates2(false); }, delay);
      } else if (manual) {
        ui.notifications.error("Polling failed. Check console for details.");
      }
    } finally {
      clearTimeout(timeoutId);
      pollInFlight = false;
    }
  }

  async function applyOneUpdate(actor, update) {
    try {
      const adapter = A();

      // Normalize action/type for robust matching (case/format agnostic)
      const act = String(update?.action ?? "").toLowerCase();
      const kind = String(update?.type ?? "").toLowerCase();

      // --- 1) Handle "requestState" FIRST so it never falls through ---
      if (act === "requeststate" || act === "request_state" || act === "request-state" || kind === "requeststate") {
        // Push current GP + inventory to the admin server, then ACK this update.
        await syncToDiscord2(actor, /*force*/ true);
        console.log("Discord Sync 2 | requestState → pushed actor state to admin.");
        return true; // marks as updated so the queue advances and gets ACKed
      }

      // --- 2) Purchase bundle (items + gold_delta) ---
      if (kind === "purchase") {
        const items = Array.isArray(update.items_added) ? update.items_added : [];
        for (const item of items) {
          await upsertItemFromCompendiumOrCreate(actor, item);
        }
        if (update.gold_delta !== undefined && update.gold_delta !== null) {
          const delta = Number(update.gold_delta);
          if (Number.isFinite(delta) && delta !== 0) {
            // Always treat gold_delta as a cost to the actor
            await adapter.addGP(actor, -Math.abs(delta));
          }
        }
        return true;
      }

      // --- 3) Add multiple items ---
      if (act === "additems" && Array.isArray(update.items)) {
        for (const it of update.items) {
          await upsertItemFromCompendiumOrCreate(actor, it);
        }
        return true;
      }

      // --- 4) Add a single item ---
      if (act === "additem") {
        const it = update.item || (
          update.name ? {
            name: String(update.name),
            qty: Math.max(1, Number(update.qty || 1)),
            // Use the payload's category/type for the item (not our normalized "kind")
            type: (typeof update.type === "string" && update.type) ? update.type : "loot"
          } : null
        );
        if (it && it.name) {
          await upsertItemFromCompendiumOrCreate(actor, it);
          console.log(`Discord Sync 2 | addItem: ${it.name} x${it.qty}`);
          return true;
        }
      }

      // --- 5) GP adjustments ---
      if (act === "deductgp" && update.amount !== undefined) {
        await adapter.addGP(actor, -Math.max(0, Number(update.amount) || 0));
        return true;
      }

      if (act === "addgp" && update.amount !== undefined) {
        await adapter.addGP(actor, Number(update.amount) || 0);
        return true;
      }

      if (act === "setgp" && update.amount !== undefined) {
        await adapter.setGP(actor, Number(update.amount) || 0);
        console.log(`💰 Set GP to ${Number(update.amount) || 0}`);
        return true;
      }

      // --- 6) Clear inventory (keep spells/features etc.) ---
      if (act === "clearinventory") {
        const keep = getPhysicalTypeSet();
        const ids = actor.items
          .filter(i => keep.has(String(i.type || "").toLowerCase()))
          .map(i => i.id);
        if (ids.length) {
          await actor.deleteEmbeddedDocuments("Item", ids);
          console.log(`Discord Sync 2 | Cleared ${ids.length} inventory item(s).`);
        } else {
          console.log("Discord Sync 2 | Inventory clear: nothing to delete.");
        }
        return true;
      }

      // --- 7) Test hook ---
      if (act === "test") {
        console.log("Discord Sync 2 | Received test update:", update);
        ui.notifications.info("Received test update from Discord (Module 2).");
        return true;
      }

      // --- 8) Remove item or decrement quantity ---
      if ((act === "remove_item" || act === "removeitem") && update.name) {
        const path = adapter.qtyPath;
        const qty = Number(update.qty || 1);
        const it = actor.items.find(i => i.name.toLowerCase() === String(update.name).toLowerCase());
        if (it) {
          const currentQty = Number(foundry.utils.getProperty(it, path) ?? 1);
          const newQty = currentQty - qty;
          if (newQty > 0) {
            await it.update({ [path]: newQty });
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

      // --- Fallback ---
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
    const qty  = Math.max(1, Number(itemData.qty || 1));
    const type = itemData.type || "loot";
    if (!name) return;

    const adapter = A();

    const path = adapter.qtyPath;
    const existing = actor.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const cur = Number(foundry.utils.getProperty(existing, path) ?? 1);
      await existing.update({ [path]: cur + qty });
      console.log(`🟡 Updated quantity for existing item: ${name}`);
      return;
    }

    let docObj = null;

    for (const packKey of adapter.packs) {
      try {
        const pack = game.packs.get(packKey);
        if (!pack) continue;
        const index = await pack.getIndex({ fields: ["name"] });
        const hit = index.find(e => (e.name || "").toLowerCase() === name.toLowerCase());
        if (hit) {
          const document = await pack.getDocument(hit._id);
          docObj = document.toObject();
          docObj.system = docObj.system || {};
          foundry.utils.setProperty(docObj, path, qty);
          console.log(`✅ Imported ${name} from ${packKey}.`);
          break;
        }
      } catch (err) {
        console.warn(`❌ Error searching ${packKey} for ${name}:`, err);
      }
    }

    if (!docObj) {
      docObj = { name, type, system: {} };
      foundry.utils.setProperty(docObj, path, qty);
      console.log(`🛠️ Created custom item: ${name}`);
    }

    try {
      await actor.createEmbeddedDocuments("Item", [docObj]);
    } catch (err) {
      console.error(`❌ Failed to create item '${name}'`, err);
    }
  }

  async function syncToDiscord2(actor, force = false) {
    if (!actor) return;
    if (isApplyingFromDiscord && !force) return;

    const token        = game.settings.get(NS, "discordToken");
    const actorId      = game.settings.get(NS, "linkedActorId");
    const guildIdWorld = (game.settings.get(NS, "guildIdWorld") || "").trim();

    if (!token || !actorId || !guildIdWorld || actor.id !== actorId) return;

    const adapter = A();

    const payload = {
      token,
      guild_id: String(guildIdWorld),
      character: actor.name,
      gold: adapter.readGP(actor),
      inventory: buildInventoryForPayload(actor)
    };

    // Mask token in log
    const _mask = t => (t ? String(t).slice(0, 8) + "…" : t);
    console.log("Discord Sync 2 | Syncing to server:", { ...payload, token: _mask(payload.token) }, { force, isApplyingFromDiscord });

    try {
      const resp = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify(payload)
      });

      const ct = resp.headers.get("content-type") || "";
      let bodyText = null, bodyJson = null;
      try { bodyText = await resp.clone().text(); } catch {}
      try { bodyJson = ct.includes("application/json") ? JSON.parse(bodyText || "{}") : null; } catch {}

      console.log("Discord Sync 2 | /sync response", {
        ok: resp.ok, status: resp.status, headers: Object.fromEntries(resp.headers.entries()),
        bodyText, bodyJson
      });

      if (!resp.ok) {
        const msg = bodyJson?.status || bodyJson?.message || bodyText || `HTTP ${resp.status}`;
        ui.notifications.error(`Push failed: ${msg}`);
      }
    } catch (err) {
      console.warn("Discord Sync 2 | Sync error:", err);
      ui.notifications.error(`Push failed: ${String(err?.message || err)}`);
    }
  }

  // handy exports for console debugging
  window.pollForUpdates2 = pollForUpdates2;
  window.getLinkedActorId2 = () => game.settings.get(NS, "linkedActorId");
  window.syncToDiscord2 = syncToDiscord2;

} // <-- end load guard

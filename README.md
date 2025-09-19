# Discord Sync Module 2 for The Golden Anvil Discord Bot

Discord bot ( The Golden Avil ) : https://discord.com/oauth2/authorize?client_id=1399873298463985664&permissions=2147609600&integration_type=0&scope=bot+applications.commands

Module Manifest:  `https://raw.githubusercontent.com/Burberrygit/discord-sync-module-2/main/module.json`

---

DND5e, Pathfinder 1&2

This project links your Discord server with Foundry Virtual Tabletop so your players’ gold and inventory always stay in sync.  
Players can buy, sell, gamble, or transfer gold right in Discord, and those changes automatically appear on their Foundry character sheets. Updates made in Foundry also sync back to Discord.

---

## How It Works

1. A player runs `/linkfoundry` in Discord to get a one-time token.
2. They paste that token into the module’s link window in Foundry. The DM just needs to set the **Guild ID** once in the module settings.
3. From then on, whenever a player buys, sells, or gambles in Discord, the bot queues updates. Foundry automatically pulls those updates and applies them to the correct character.


---

## Player Setup

1. In Discord, type `/linkfoundry`. The bot will give you a link token and show the Guild ID.  
2. In Foundry, open the Sync Module panel and paste in your token.  
3. That’s it! Your gold and items will now stay updated across both platforms.  

To disconnect, just use `/unlinkfoundry`.

---

## DM Setup

1. Install the module in Foundry using the manifest URL above.  
2. Enable it for your world.  
3. Enter the Guild ID (shown when players use `/linkfoundry`) in the module’s settings.  

After that, your players can link their characters, and the system will handle everything automatically.

---

## Commands

Here’s what players can do once they’re linked:

### Linking
- **`/linkfoundry`** – Generates a token and shows your Guild ID. Use this to link your Discord account to your Foundry character.  
- **`/unlinkfoundry`** – Removes your link.

### Market & Gold
- **`/market`** – View all items for sale.  
- **`/buy <item> [qty]`** – Buy an item. Price may shift a little depending on a d20 persuasion roll. Gold is deducted and the item is added to your Foundry character.  
- **`/sell <item> [qty]`** – Sell an item from your inventory. Usually sells for 50–75% of the listed value, depending on a persuasion roll.  
- **`/transfergp <member> <amount>`** – Send gold to another player.  
- **`/balance`** – Check your current gold.  
- **`/inventory`** – Show what you’re carrying.  
- **`/pricecheck <item>`** – See what an item would sell for.

### Sync & Backups
- **`/restorebackup`** – Roll back to your most recent backup (gold and items).  
- **`/refreshinventory`** – Force a full resync between Discord and Foundry.

### Roulette
- **`/roulette <amount> [odd/even|none] [red/black/green|none]`** – Gamble your gold! Wins and losses update your character sheet. Loses feed into the jackpot, which grows until someone hits it.

### Admin / DM Tools
- **`/additem <name> <qty> <cost> <type>`** – Add an item to the market.  
- **`/setgp <amount>`** – Set your gold directly.  
- **`/marketadmin`** – Get a link to the web-based admin panel.  
- **`/diagnose`** – Quick bot/connection test.

---

## Tips

- If a sync doesn’t seem to go through, try `/refreshinventory` to push a clean update to Foundry.  
- If a player loses their link or token, they can just run `/linkfoundry` again. Any pending updates get carried over automatically.  
- Buy/sell receipts are public in the channel (so everyone sees the marketplace action). Most other commands are private (ephemeral).

---

## License

This module includes a `LICENSE` file in the repo and in the module zip. In short: it’s free for personal, non-commercial use inside Foundry, but redistribution or commercial use isn’t allowed without permission.

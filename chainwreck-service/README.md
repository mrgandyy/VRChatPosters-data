# ChainWreck Worlds service

One Discord bot process holds the SQLite database and publishes 2048 × 2048 poster atlases. The bot is for ChainWreck Worlds by TwerkTaco & Resolve; SHXTTY is one possible premium partner. Standard groups can replace slots 1–8, premium groups 1–16. Unassigned slots use the 16 bundled default artworks. Codes are public preset selectors and never confer in-world roles.

## Local dry run

Use Node.js 22 or later. In this directory run `npm ci`, `npm run build`, `npm test`, and `npm run dry-run`. Inspect `data/dry-run/group-0-atlas.png` and `data/dry-run/catalog.json`. Dry run does not contact GitHub or Discord. The source defaults are in `defaults/`; edit these files only with approval from the world owner.

## Discord account setup

1. Create a Discord application and bot, then invite it to the intended server with scopes `bot` and `applications.commands`. Grant View Channels, Send Messages, Embed Links, Attach Files, Read Message History, and Manage Channels if the bot should create its own channels. The bot uses the Guilds intent only. It does not need Message Content or Guild Members privileged intents.
2. Copy `.env.example` into your host's private environment settings. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`. Never paste the token into Discord, Unity, GitHub, or a screenshot.
3. Start `node dist/bot.js`. A server administrator runs `/cw-setup` to select existing channels or create `chainwreck-submit`, `chainwreck-help`, `chainwreck-approvals`, and `chainwreck-log`. Select reviewer and administrator roles. The approval and log channels are made private. Repeating setup updates the same persistent panel when available.
4. Use `/group register`, `/group representative`, `/group tier`, `/group code`, `/group page`, and `/group suspend` for partners. Each assigned representative runs `/group accept` to record the current verified-18+ hosting agreement. This records an agreement, not actual VRChat compliance.
5. Representatives use `/poster submit` with a static JPEG, PNG, or WebP (maximum 12 MB and 30 megapixels). The bot saves the attachment immediately on its volume. Reviewers use the buttons in the private approval channel. Approved work enters the publishing queue. `/poster list`, `/poster remove`, `/group mine`, `/publish status`, `/publish retry`, and `/publish rollback` handle day-to-day operation.

## GitHub Pages asset feed

Create or use a dedicated public repository for the feed. Enable Pages from its branch root. Create a fine-grained GitHub personal access token limited to that repository with **Contents: Read and write**. Set `GITHUB_OWNER`, `GITHUB_REPOSITORY`, `GITHUB_BRANCH`, `GITHUB_PUBLIC_BASE` (the exact `https://NAME.github.io/REPO` Pages base), and `GITHUB_TOKEN` in the host settings. Change `CHAINWRECK_DRY_RUN=false` only after a dry run and repository setup. The publisher uploads an immutable numbered atlas, verifies its public bytes, then uploads the catalog and verifies it. A failure leaves the earlier active catalog in place where possible. Keep this delivery URL replaceable: GitHub Pages' terms restrict online business and SaaS uses, so reconsider hosting before paid partner commerce.

The world scene currently authors `https://mrgandyy.github.io/VRChatPosters-data/catalog.json` and 256 immutable atlas URLs at that base. After configuring live publishing, an administrator runs `/publish retry group:0` to publish the default atlas and catalog first, then verifies those two public URLs before registering partner groups. If the actual repository or domain differs, change `PublicBase` in `Assets/ChainWreck/Editor/ChainWreckSceneIntegration.cs`, update the scene's controller URLs in the Unity Inspector or a controlled editor migration, then reupload the world. Changing a code, artwork, tier, or group name within the authored pool does not require a world reupload. Capacity is **32 groups including default**, each with **8 release URLs**. Expanding either count or changing the URL base requires world reupload. After the eighth distinct atlas revision for a group, publication fails clearly instead of overwriting a cached URL.

## Low-cost host

One Railway service with a persistent volume is the simple initial deployment. Railway Hobby currently has a $5/month minimum that includes $5 of usage; CPU, memory, network, and volume usage beyond included credit are billed separately. Treat $5 as the minimum, not a guaranteed total. The free tier has tighter credit and storage and is a poor uptime choice for a review bot. Build with `npm ci && npm run build`; start with `npm start`. Mount a persistent volume and set `CHAINWRECK_DATA_DIR` to its mounted path. Keep `CHAINWRECK_DEFAULTS_DIR` pointing at the shipped `defaults` directory. Run one replica only because SQLite and the publisher are single-process. Give Sharp enough memory for a 2048-square atlas and source decode; inspect host usage after real submissions. Do not enable a paid plan until approved by the account owner.

## Backup and recovery

Back up the entire persistent data directory, including SQLite database, WAL files if present, saved sources and previews, and dry-run output, with the bot stopped or using SQLite's backup API for a hot snapshot. Keep versioned off-host backups and periodically test restoration. GitHub holds published atlases and catalog but is not a substitute for source/approval records. On restart, interrupted publishing jobs become retryable. Use `/publish status` and `/publish retry` after investigating a failure. `/publish rollback` points the public catalog to an earlier release only after checking that atlas still exists; it does not erase newer revisions. Keep the previous catalog commit for a manual emergency rollback.

## Operational limits

VRChat Udon image and string downloads are rate limited and subject to client caching. The world refreshes periodically or on staff request, so publication is not instantaneous. Each client keeps its last valid downloaded atlas when a replacement fails. The catalog and all codes are public. Staff/Dancer/VIP permissions remain in TTSS, separate from Discord representatives and group selection. Live two-client, Group-instance, PC, Quest, and headset tests remain necessary before release.

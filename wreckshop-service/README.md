# Wreckshop Worlds service

## Group management (6 October 2026)

Each Discord user may represent only one group, including admins acting as representatives. Administrative access still lets admins manage all groups. Registration repeats return the existing group, and a VRChat group ID cannot be registered twice. `/group rename group:<number> name:<actual group name>` changes a represented group; `/group delete group:<number> confirm:true` removes it from the catalog and releases its Discord assignments. Admins may also use these controls. Linking is available to standard groups for identity configuration; the in-world Join Group button remains Premium-only.

On startup, duplicate VRChat identities, or duplicate names with the same representative and no conflicting VRChat IDs, are archived automatically. Empty unrepresented seed entries also yield to a matching real group. Prefer Premium, then more assigned artwork, then linked/represented entries, then oldest ID. Distinct represented groups with matching names are retained. Discord users with multiple distinct legacy assignments retain the oldest assignment; the groups themselves remain. Archived entries retain artwork, approval history, codes and immutable URL slots for recovery. Their codes no longer activate groups. Delete does not reclaim the finite preauthored atlas URL capacity: overwriting published immutable URLs would break cached world artwork. The first migration makes a consistent SQLite snapshot alongside the database before cleanup; duplicate mappings are recorded in settings.

The owner selected manual group names instead of authenticated VRChat name lookup. `name` requires the actual group name and rejects pasted URLs and grp_ IDs with instructions. Put an optional official VRChat URL or ID in `vrchat_group` when registering, or use `/group link` afterward. Linking never overwrites the name. Use `/group rename` to correct existing URL-named entries. No VRChat account/session or automatic API lookup is required.

The dancer whitelist and dancer self-claim feature were deferred by the owner and are not included in this change.

One Discord bot process holds the SQLite database and publishes 2048 × 2048 poster atlases. The bot is for Wreckshop Worlds by TwerkTaco & Resolve; SHXTTY is one possible premium partner. Standard groups can replace slots 1–8, premium groups 1–16. Unassigned slots use the 16 bundled default artworks. Codes are public preset selectors and never confer in-world roles.

## Local dry run

Use Node.js 22 or later. In this directory run `npm ci`, `npm run build`, `npm test`, and `npm run dry-run`. Inspect `data/dry-run/group-0-atlas.png` and `data/dry-run/catalog.json`. Dry run does not contact GitHub or Discord. The source defaults are in `defaults/`; edit these files only with approval from the world owner.

## Discord account setup

1. Create a Discord application and bot, then invite it to the intended server with scopes `bot` and `applications.commands`. Grant View Channels, Send Messages, Attach Files, Read Message History, and Manage Channels if the bot should create its own channels. The bot uses the Guilds intent only. It does not need Message Content or Guild Members privileged intents.
2. Copy `.env.example` into your host's private environment settings. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`. Never paste the token into Discord, Unity, GitHub, or a screenshot.
3. Start `node dist/bot.js`. A server administrator runs `/ws-setup` to select existing channels or create `wreckshop-submit`, `wreckshop-help`, `wreckshop-approvals`, and `wreckshop-log`. Select reviewer and administrator roles. The approval and log channels are made private. Repeating setup updates the same persistent panel when available.
4. Anyone in the configured Discord can use `/group register name:...` to create a standard group and automatically become its representative. Representatives can submit posters and set `/group code` and `/group page`. Only admins assign premium with `/group tier` or manage suspension and additional representatives. `/group accept` is an optional VRChat rules acknowledgment, never a submission gate or age-verification check.
5. Representatives use `/poster submit` for one image or `/poster batch` for up to eight images, each with its own slot. Each image must be a static JPEG, PNG, or WebP (maximum 12 MB and 30 megapixels). The bot saves attachments on its volume and creates a separate review item for every poster. Reviewers use the buttons in the private approval channel. Approved work enters the publishing queue. `/poster list`, `/poster remove`, `/group mine`, `/publish status`, `/publish retry`, and `/publish rollback` handle day-to-day operation.

6. Premium representatives use `/billboard submit group:ID image:...` for a wide 4:1 banner (ideally 2048 x 512). It uses the existing review channel. After approval and publication, selecting that group code displays the banner above the entrance and a **Join [group name]** button above **I agree**. Set the group page with `/group page` to enable that button. Standard groups retain free poster uploads. The button opens VRChat's group page; it does not automatically join or require membership.

Billboards have a separate immutable pool of eight images per group, with retries reusing the same reserved image URL. Downgraded or suspended groups do not display a banner. Group registration capacity remains 32 total including the default; expanding capacity requires an updated world.

## GitHub Pages asset feed

Create or use a dedicated public repository for the feed. Enable Pages from its branch root. Create a fine-grained GitHub personal access token limited to that repository with **Contents: Read and write**. Set `GITHUB_OWNER`, `GITHUB_REPOSITORY`, `GITHUB_BRANCH`, `GITHUB_PUBLIC_BASE` (the exact `https://NAME.github.io/REPO` Pages base), and `GITHUB_TOKEN` in the host settings. Change `WRECKSHOP_DRY_RUN=false` only after a dry run and repository setup. The publisher uploads an immutable numbered atlas, verifies its public bytes, then uploads the catalog and verifies it. A failure leaves the earlier active catalog in place where possible. Keep this delivery URL replaceable: GitHub Pages' terms restrict online business and SaaS uses, so reconsider hosting before paid partner commerce.

The world scene currently authors `https://mrgandyy.github.io/VRChatPosters-data/catalog.json` and 256 immutable atlas URLs at that base. After configuring live publishing, an administrator runs `/publish retry group:0` to publish the default atlas and catalog first, then verifies those two public URLs before registering partner groups. If the actual repository or domain differs, change `PublicBase` in `Assets/Wreckshop/Editor/WreckshopSceneIntegration.cs`, update the scene's controller URLs in the Unity Inspector or a controlled editor migration, then reupload the world. Changing a code, artwork, tier, or group name within the authored pool does not require a world reupload. Capacity is **32 groups including default**, each with **8 release URLs**. Expanding either count or changing the URL base requires world reupload. After the eighth distinct atlas revision for a group, publication fails clearly instead of overwriting a cached URL.

## Low-cost host

One Railway service with a persistent volume is the simple initial deployment. Railway Hobby currently has a $5/month minimum that includes $5 of usage; CPU, memory, network, and volume usage beyond included credit are billed separately. Treat $5 as the minimum, not a guaranteed total. The free tier has tighter credit and storage and is a poor uptime choice for a review bot. Build with `npm ci && npm run build`; start with `npm start`. Mount a persistent volume and set `WRECKSHOP_DATA_DIR` to its mounted path. Keep `WRECKSHOP_DEFAULTS_DIR` pointing at the shipped `defaults` directory. Run one replica only because SQLite and the publisher are single-process. Give Sharp enough memory for a 2048-square atlas and source decode; inspect host usage after real submissions. Do not enable a paid plan until approved by the account owner.

The deployed project is `wreckshop-worlds` in Railway, with service `wreckshop-bot` sourced from the `main` branch of `mrgandyy/VRChatPosters-data`. Its root directory is `/wreckshop-service`, its build command is `npm run build`, and its start command is `npm start`. The persistent volume is mounted at `/app/data`; production sets `WRECKSHOP_DATA_DIR=/app/data`, `WRECKSHOP_DRY_RUN=false`, and `WRECKSHOP_AUTO_SETUP=true`. On startup the bot reuses or creates the four named channels, matches the `Wreckshop Admin` and `Wreckshop Reviewer` roles by name, restores the submission panel, and queues the default atlas only if it has no live release. Railway has no GitHub deployment trigger for this service, so publishing catalog and atlas commits will not restart the bot. After changing service code, run `railway service redeploy --from-source --yes` from a linked Railway CLI directory or redeploy from the Railway dashboard.

## Backup and recovery

Back up the entire persistent data directory, including SQLite database, WAL files if present, saved sources and previews, and dry-run output, with the bot stopped or using SQLite's backup API for a hot snapshot. Keep versioned off-host backups and periodically test restoration. GitHub holds published atlases and catalog but is not a substitute for source/approval records. On restart, interrupted publishing jobs become retryable. Use `/publish status` and `/publish retry` after investigating a failure. `/publish rollback` points the public catalog to an earlier release only after checking that atlas still exists; it does not erase newer revisions. Keep the previous catalog commit for a manual emergency rollback.

## Operational limits

VRChat Udon image and string downloads are rate limited and subject to client caching. The world refreshes periodically or on staff request, so publication is not instantaneous. Each client keeps its last valid downloaded atlas when a replacement fails. The catalog and all codes are public. Staff/Dancer/VIP permissions remain in TTSS, separate from Discord representatives and group selection. Live two-client, Group-instance, PC, Quest, and headset tests remain necessary before release.

## Wreckshop Worlds rename

The first startup migrates the legacy SQLite file with SQLite's online backup API, including committed WAL records, into `wreckshop.sqlite`. It retains the original file for recovery and never overwrites an existing new database. Only the built-in default group's old name changes; partner IDs, codes, representatives, approvals, releases, channel IDs, and role IDs are preserved. Old pending review buttons remain usable. Compatibility strings are isolated in `src/branding.ts`; historical backups retain their original names. The new public commands are `/ws-setup` and `/ws-help`.
# Premium FBT Social photo backdrop

`/backdrop submit group:<group-id> image:<attachment>` submits a photo-wall background independently of the entrance billboard. The caller must represent the enabled premium group (or have the existing administrator permission). Existing reviewers approve or reject the submission in the configured approval channel. Accepted images are fitted into a 2048 × 1536 PNG; the existing upload validation applies.

Approved artwork is published under the independent `backdrops/` URL pool and selected through `backdropPoolIndex` in the catalog. The Unity photo wall retains its default FBT artwork while loading, after a failed image request, and whenever there is no eligible premium group. Each group has eight immutable backdrop revisions, matching the preauthored Unity URL pool. Repeated publication of identical artwork reuses the same revision.

Build with `npm run build` and run `npm test`. Restart the deployed bot with its existing configuration to register the new slash command. Updating this repository alone does not restart the deployed service or publish a new VRChat world.


## Premium Join group destination

Join group is Premium-only. `/group register name:<name> tier:premium vrchat_group:<grp_UUID-or-official-URL>` requires the partner's VRChat group ID; Standard registration does not require it. IDs are accepted in `grp_` UUID form or as an official `https://vrchat.com/home/group/` URL and stored canonically. Format validation does not verify ownership of the external VRChat group.

Existing Premium representatives use `/group link group:<Wreckshop-number> vrchat_group:<grp_UUID-or-official-URL>`. The legacy `/group page group:<number> url:<ID-or-URL>` remains available for Premium groups. These commands use the existing representative/admin permission check and queue publication. `/group mine` and the panel's groups action show the configured destination, or ask Premium representatives to supply their missing ID. A Premium tier change also displays this setup prompt when needed.

The world opens the active Premium group's VRChat page. The button remains hidden without a configured link and for Standard groups. No example ID is assigned automatically, and opening the page does not automatically join a player to a group.

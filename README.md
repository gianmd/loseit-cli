# loseit — an agent-friendly Lose It! CLI

A command-line client for [Lose It!](https://www.loseit.com) built for other AI agents (and
scripts): read your diary and calorie budget, log / edit / delete entries, search and create
foods, and create recipes. Every command prints JSON on stdout; errors are JSON on stderr
with exit code 1. No server to host.

> ⚠️ **Unofficial.** Lose It! has no public API. This talks to the private GWT-RPC API
> behind the loseit.com web app. Only use it with your own account.

## Setup

```bash
npm install
npm run build
npm link            # puts `loseit` on your PATH
```

Credentials go in `~/.config/loseit/.env` (or in the environment):

```bash
LOSEIT_EMAIL=you@example.com
LOSEIT_PASSWORD=...
LOSEIT_TIMEZONE=America/Toronto   # optional, defaults to the system timezone
```

Then run `loseit auth login`. The session cookie and the generated RPC schema are cached
in `~/.config/loseit/` (override the location with `LOSEIT_HOME`).

## Commands

| Command | What it does |
|---|---|
| `loseit day [-d DATE]` | Entries by meal, budget, food, exercise, **remaining**, nutrient totals |
| `loseit summary [-d END] [-n DAYS]` | Per-day budget / food / exercise / remaining plus totals (default: the 7 days ending today) |
| `loseit food search <query>` | Search the food database (returns ids) |
| `loseit food show <id>` | Nutrients per serving and the serving units you can log in |
| `loseit food mine [query] [--custom]` | Your foods (`--custom`: only the ones you created) |
| `loseit food create --name N --calories C [--protein ...] [--log -m MEAL]` | Create a custom food; `--log` also logs one serving |
| `loseit food delete <id>` | Delete a custom food |
| `loseit log add <foodId> -m MEAL [-s N \| -a N -u UNIT] [-d DATE]` | Log a food or recipe |
| `loseit log edit <entryId> [-d DATE] [-s N \| -a N [-u UNIT]] [-m MEAL] [--move-to DATE]` | Change an entry |
| `loseit log copy --from DATE [-m MEAL] [--to DATE] [--to-meal MEAL] [--entry ID...]` | Re-log a past meal/day/entries (e.g. `--from -2 -m breakfast`) |
| `loseit log delete <entryId> [-d DATE]` | Delete an entry |
| `loseit recipe list [query]` | Your recipes |
| `loseit recipe show <id>` | Ingredients, totals, per-serving nutrition |
| `loseit recipe create --name N --servings S -i FOOD[:AMT[:UNIT]] ...` | Create a recipe |
| `loseit recipe delete <id>` | Delete a recipe |
| `loseit schema` | Re-resolve the web build and list every RPC method |
| `loseit rpc <method> [json]` | Call a raw RPC with primitive params (debugging) |

Dates accept `YYYY-MM-DD`, `today`, `yesterday`, `tomorrow` or an offset like `-3`.
Meals are `breakfast`, `lunch`, `dinner`, `snacks`. Units accept Lose It names or short
forms (`g`, `ml`, `oz`, `cup`, `tbsp`, `tsp`, `each`, `serving`, ...).

### Example

```bash
$ loseit food search greek yogurt --limit 3          # → [{"id": "<food-id>", "name": ...}]
$ loseit food show <food-id>                          # → servingOptions: Each, Gram, ...
$ loseit log add <food-id> -m breakfast -a 170 -u g
$ loseit day --compact | jq '{budget, food, remaining}'
$ loseit recipe create --name "Overnight oats" --servings 2 \
    -i <oats-id>:80:g -i <milk-id>:250:ml -i <banana-id>:1
```

## How it works

Lose It's web app is a GWT application. GWT-RPC is a positional binary-ish protocol whose
wire layout is baked into the compiled JavaScript and changes on every deploy. Instead of
hard-coding payloads, this CLI **derives the protocol from the live build**:

1. `src/gwt/build.ts` fetches `web.nocache.js`, the current permutation's `*.cache.js`
   and all deferred fragments.
2. `src/gwt/schema.ts` finds GWT's serializer table
   (`a[TypeSignature] = [instantiate, deserialize, serialize]`), classifies the
   obfuscated stream primitives by their bodies (readObject, readLong, ...), and replays
   each serializer into an ordered field list. It also extracts every service method's
   parameter signature, the serialization policy hash, and enum constant names.
3. `src/gwt/codec.ts` is a generic, schema-driven encoder/decoder: responses decode into
   full object trees (with back-references, `.concat()`-split payloads, etc.) and
   requests encode from the same trees.
4. `src/loseit/model.ts` / `api.ts` map field positions to meaning and implement the
   operations the same way the web app does (validated against captured web traffic —
   see `test/fixtures`; the codec re-encodes those captures byte-for-byte).

When Lose It redeploys, the CLI notices the new permutation, regenerates the schema and
keeps working; a stale build surfaces as `IncompatibleRemoteServiceException` and triggers
a refresh automatically.

### Notes

- Moving an entry to another date is a copy + delete (the server stores entries per day),
  so the moved entry gets a new id.
- `--servings` on foods measured in Lose It's "Serving" unit (most recipes) means that unit;
  otherwise it is a multiple of the food's default serving.
- Freshly created custom foods aren't returned by `getFood`, so the CLI falls back to your
  custom-food list.

## Development

```bash
npm run dev -- day          # run from source
npm test                    # codec tests against captured web traffic
npm run check               # typecheck
LOSEIT_DEBUG_DIR=/tmp/li npm run dev -- day   # dump raw RPC requests/responses
npx tsx scripts/decode-capture.ts <schema.json> <file.req.txt>  # decode captured traffic
```

## Using it from agents

`skill/SKILL.md` is a ready-made Claude Code skill describing the command surface. Install it with:

```bash
mkdir -p ~/.claude/skills/loseit && cp skill/SKILL.md ~/.claude/skills/loseit/
```

Any other agent can use the same file as instructions — it only needs shell access to `loseit`.

## Credits

Prior reverse-engineering by [atfinke/loseit-mcp](https://github.com/atfinke/loseit-mcp) and
[RichClarkeAI/loseit-cli](https://github.com/RichClarkeAI/loseit-cli) showed that the web
GWT-RPC API was workable (login endpoint, the food-logging flow). This project's codec and
schema extraction are written from scratch.

## License

MIT

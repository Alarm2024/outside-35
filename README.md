# Outside 35

**A small plan to get you outside. It never guesses.**
By elghaly. Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 1: Touch Grass.

**Try it:** https://alarm2024.github.io/outside-35/ (phone first; works in any modern browser)

<img src="docs/screenshot.png" alt="Outside 35 on a phone: Walk selected, a location typed in, weather marked UNKNOWN because it was not fetched, and a plan with a 45-minute window in UTC and local time" width="360">

*Screenshot from the automated browser test: location typed in, weather not fetched (so it says UNKNOWN), model not loaded (so the built-in text is shown).*

## What it does

1. Pick a plan: **Walk** (45 min), **Hike** (3 h) or **Garden** (1 h).
2. Optionally share or type your location, check the weather, and download the model.
3. Tap **Make my plan**. You get:
   - **Best time:** a window shown in UTC and in your device's time zone, with the reason it was picked.
   - **Bring:** a short list.
   - **Notice one thing:** a bird, a tree, the sky.

### The rule: UNKNOWN, never a guess

If the app does not have the data, it says so: <code>UNKNOWN</code> plus the reason. It never fills a gap with a made-up number.

- No location → the time window is UNKNOWN ("location not shared yet").
- No weather → the window is based on daylight only, and the weather line says UNKNOWN and why (not fetched, no signal, or older than 3 h).
- A field missing from the forecast → that field is UNKNOWN, not zero.
- Polar night → it says the sun stays down, not "go at noon".

## How it works

| Part | Who does it | How |
|---|---|---|
| Sunrise and sunset | Code, on your device | The standard solar equations (the ones SunCalc uses). Tested against published Greenwich almanac times. |
| Weather | [Open-Meteo](https://open-meteo.com), only when you tap **Check weather** | Free, no account, no API key. Your position is rounded to two decimals (about 1 km) before it is sent. |
| Best time window | Code | The daylight slot with the lowest rain chance and the most comfortable temperature, wind and UV. With no weather, it is the earliest daylight slot that fits. Ends at least 15 min before sunset. |
| What you must bring | Code | Chosen from the data, each with its reason: "a rain jacket (rain likely)", "sunscreen (strong sun)". With no weather: "a light layer (weather unknown)". |
| Which Notice lines are allowed | Code | Lines written by people, each tied to the data it needs: "Watch how the rain darkens the ground" only with rain in the forecast, "Look for new buds" only in spring at your location. With no weather, no weather lines at all. |
| The rest of "Bring", and "Notice" | **Gemma 3 270M IT**, in your browser | The model **ranks**; it does not write. It is asked about your plan in words, not numbers ("a hike on a cold, rain likely day in the morning in winter"), and scores every allowed answer by how much more likely it finds it for this plan than for no plan at all. Its top three things to bring and its top Notice line are shown, and the full ranking is one tap away. |

The model chooses; code decides what it may choose from and works out every number. It cannot invent a fact or an item, because every answer is a line we wrote that your data allows.

**Why ranking, not writing.** We first asked Gemma 3 270M to write the lines. On ten test plans it copied the whole list instead of choosing, and its sentences were often off-topic ("The aroma of cinnamon and cloves is delicious!"). A word filter can catch numbers and weather claims, but not that. Ranking uses what a small model is good at, judging what fits, and every answer reads well. The measurements are in the pull request that made the change.

### The model

- **Gemma 3 270M IT** (open weights from Google), ONNX build [`onnx-community/gemma-3-270m-it-ONNX`](https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX), `q4` quantisation.
- **Download:** about 344 MB, once (323 MB weights, 20 MB tokenizer, small config files). After that it loads from your browser's cache.
- **Runs with** [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 on WebGPU when your browser has it, otherwise on the CPU with WebAssembly. ONNX Runtime's WASM files are served from this site, not a CDN.
- **Runs in a Web Worker,** so the page keeps responding while the model works. The built-in choice shows at once, then "ranking our lists… n/m", then the model's choice.
- **Fast enough on a phone's CPU.** In the browser's CPU build each model call costs a fixed amount whatever its length (the 4-bit output layer is unpacked every call), so the app makes few calls:
  - Each question's prompt is read once and its cache reused for every answer. On the CPU it is read inside the shortest answer's run.
  - At most six Notice lines go to the model, the ones tied to your plan's data first.
  - The no-plan scores are the same for every plan, so they are worked out once in CI (`npm run baselines`) and shipped in `src/lib/baselines.json`. The Model check fails if they drift.
  - GitHub Pages cannot send the headers that make a page cross-origin isolated, which ONNX Runtime needs to use more than one CPU thread. So the service worker adds them to every page and file it serves. A first visit reloads once when you tap Download.
- **Measured in CI** (headless Chromium, 4-core GitHub runner), seconds to rank one plan, before and after in the same run:
  - Faster runner: 31.9 → 5.6 s and 32.2 → 5.6 s; the six test plans took 4.6–5.6 s.
  - Slower runner: 57.9 → 10.6 s and 59.3 → 10.7 s; the six plans took 9.2–10.7 s.
  - On one thread (a browser that does not allow isolation): 17–20 s.
  - Real phones are not measured yet.
- **WebGPU** reads the prompt once too, as its own call, because cutting a cache needs it in CPU memory. In CI, on a software GPU, one full run per answer disagreed with the CPU by up to 0.53; this way matches it to 0.001. The Model check fails if they drift apart.
- **Two runtime builds, on purpose.** The q4 file uses a quantized operator (`GatherBlockQuantized`) that ONNX Runtime's WebGPU-capable build runs only on the GPU. So WebGPU devices use that build, and every other device uses the plain build, which runs it on the CPU. If WebGPU fails on a device, the app starts a fresh worker on the CPU and remembers that, with no second download.
- **Checked before the download.** Before fetching 344 MB, the worker runs two tiny graphs (about 1 KB each) holding the model's quantized operators. If this browser cannot run them, it says so and downloads nothing. `npm run probe-ort` runs the same check on both builds in CI.
- **No server inference, no closed-model API, no account.** The page makes only two kinds of outside requests, and only when you tap for them: the model files from Hugging Face (**Download**), and the forecast for your rounded position from Open-Meteo (**Check weather**).
- **License:** the code here is MIT. Gemma's weights are under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms); they are downloaded from Hugging Face, not stored in this repo.

### Offline

It is a PWA. After the first visit, the app works with no signal. The model works offline once you have downloaded it. Weather is then UNKNOWN ("no signal"), and the window falls back to daylight only.

## What is tested

- `npm test`: 35 unit tests, covering:
  - sun times (Greenwich solstices within 3 min of the almanac, polar day and night);
  - window picking, and which lines the data allows (at most six Notice lines, the plan's own first);
  - the ranking maths, and with a stand-in model, that reading the prompt once gives exactly the same scores as one full run per answer;
  - weather parsing and staleness, and "the questions have no numbers".
- `npm run smoke`: headless Chromium against the built site. UNKNOWN states, UTC and local times, a weather fixture, offline reload via the service worker, a first visit reloading once so the page is cross-origin isolated, a runtime that cannot run the model being reported before any download, the footer not claiming the model wrote anything until it is loaded, and that without the model download the page contacts nobody except Open-Meteo, and only when asked.
- `npm run probe-ort`: the shipped ONNX Runtime builds against the model's quantized operators, on the CPU and on WebGPU (SwiftShader, a software GPU, so no graphics card is needed).
- **Model check** (GitHub Actions, `model-check.yml`): loads the real Gemma 3 270M IT (q4) with the app's own ranking code and option lists, and writes what it chose for each test plan to the job summary. It fails if the choices do not change with the plan. It does this in Node, then in headless Chromium on the CPU and on WebGPU, each time making a plan, reloading with no signal, loading the model again from the browser cache and making another plan. It also:
  - times each plan the old way (one full run per answer) and the app's way, on the CPU with and without threads, and fails if two ways of ranking the same plan on the CPU differ by more than 0.001;
  - fails if the shipped no-plan scores are out of date, or if the app's WebGPU scores differ from the CPU's for the same plan by more than 0.02.
- **Not tested automatically:** real phones and real GPUs. The WebGPU run uses a software GPU.

## Run it yourself

```bash
npm ci --ignore-scripts   # browser build needs no native binaries
npm test
npm run build             # writes dist/
npx serve dist            # or any static server, then open the URL it prints
```

Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml` (test → build → browser smoke test → deploy).

## Privacy

No account, no cookies, no analytics, no tracking. Outside requests happen only when you tap for them: the model download from Hugging Face, and the weather from Open-Meteo. Your plan choice, rounded location and last forecast are kept in this browser's local storage, so the app can work offline. Clear the site's data to remove them.

## Credits

Built with AI assistance (Claude). Sun formulas from Astronomy Answers (aa.quae.nl). Weather by Open-Meteo. Model by Google (Gemma), ONNX conversion by onnx-community.

MIT © elghaly

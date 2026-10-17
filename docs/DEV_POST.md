---
title: "Outside 35: a small plan to get you outside, from a model that only ranks what people wrote"
published: false
# Tags: UNKNOWN until checked on the challenge page. The challenge hub points to
# #hf26challenge; #devchallenge is the usual DEV challenge tag. Confirm both before publishing.
tags: devchallenge, hf26challenge, ai, opensource
# cover_image: see "Cover image idea" at the end (remove this note before publishing)
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge, Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05).*

<!-- Draft. Wyndham fills the PENDING lines after the phone test, then publishes. Only the first entry per person is judged. -->

## What I Built

**Outside 35** is a small web app that gets you off the screen. Pick a **walk**, a **hike** or some **garden** time, and it gives you a short plan:

- **Best time:** a window shown in UTC and in your device's own time zone, with the reason it was picked.
- **Bring:** a short list.
- **Notice one thing:** a bird, a tree, the sky.

An open-weight model, **Gemma 3 270M IT**, runs inside your browser tab, in a Web Worker. There is no account, no server of ours and no tracking.

It follows one rule we use in everything we build at elghaly: **it never guesses.** If it does not have the data, it says `UNKNOWN` and why. No location: the time window is UNKNOWN, with the reason. No weather: the window is based on daylight only, and the weather line says UNKNOWN (not fetched, no signal, or older than 3 hours). It does not make up a temperature to look helpful.

## Demo

- Try it on your phone: **https://alarm2024.github.io/outside-35/**
- After the first visit it works with no signal. Once you have downloaded the model, that works with no signal too.
- Phone test: **PENDING (Wyndham)**. Phone model, browser, "your GPU (WebGPU)" or "your CPU (WebAssembly, N threads)", download time, and seconds per plan.

<!-- PENDING (Wyndham): a short screen recording. Tap Walk, share location, Download, Make my plan; then flight mode, reload, Make my plan again. -->

## Code

{% github Alarm2024/outside-35 %}

MIT licensed. Gemma's weights are under the Gemma Terms of Use; they are downloaded from Hugging Face, not stored in the repo.

## How I Built It

The work is split so the model never handles a fact:

| Part | Who does it |
|---|---|
| Sunrise, sunset, the time window | Code on your device (standard solar equations, tested against the Greenwich almanac) |
| Weather | [Open-Meteo](https://open-meteo.com), only when you tap **Check weather**. Free, no key. Your position is rounded to about 1 km first. |
| What you must bring (a rain jacket when rain is forecast) | Code, from the data |
| Which "Notice" lines are allowed (no rain line without rain in the forecast) | Code, from the data |
| The rest of "Bring", and the "Notice" line | **Gemma 3 270M IT ranks** lines that people wrote, in the browser with [Transformers.js](https://github.com/huggingface/transformers.js) (WebGPU when available, otherwise WebAssembly) |

### Gemma ranks; it does not compose

This is the most useful thing we learned. Our first version asked Gemma for free text. We ran it on ten plans in CI: it copied the whole option list instead of choosing, and many sentences were off-topic ("The aroma of cinnamon and cloves is delicious!"). A filter can catch numbers and weather claims, but not that.

So now:
1. **People write the lines.** A fixed list for Bring, a fixed list for Notice.
2. **The data decides which lines are allowed.** No rain line without rain in the forecast.
3. **Gemma scores each allowed line** by how much more likely it finds it as the answer for *your* plan than for no plan at all. This is pointwise mutual information. Plain likelihood made one line win five of six test plans; this way the choice follows the plan.

On a cold, rainy winter hike it picked "Notice your breath in the cold air"; in a warm summer garden, "Find a patch of shade and feel how much cooler it is". (Those are from the CI job log.) It can choose, but it cannot invent a fact, and every line on screen is one a person wrote. The model gets words ("a cold, rain likely day"), never numbers; every number on screen comes from code and data.

### Making it fast on a phone's CPU

A phone without WebGPU runs the model on the CPU (WebAssembly). There, every model call costs about the same whatever its length, so we cut the number of calls:

- Each question's prompt is read **once**, and its cache is reused for every answer.
- At most six Notice lines go to the model, the ones tied to your plan's data first.
- The "no plan" scores are the same for everyone, so they are worked out once in CI and shipped with the app.
- GitHub Pages cannot send the headers ONNX Runtime needs for more than one CPU thread, so a service worker adds them; a first visit reloads once.

**Measured** in CI (headless Chromium on a 4-core GitHub runner), seconds to rank one plan, before and after on the same runner ([run 37796780935](https://github.com/Alarm2024/outside-35/actions/runs/37796780935)):

| | Before | After |
|---|---|---|
| CPU, 4 threads | 51.5 s and 52.1 s | 6.6–7.8 s (six test plans) |
| CPU, 1 thread (no isolation) | — | 15.3–17.5 s |

GitHub's runners vary in speed: other runs measured 31.9 s → 4.6–5.6 s and 57.2 s → 7.8–9.1 s (all runs are listed in the README). Real phones: **PENDING (Wyndham)**.

On WebGPU, CI uses a software GPU (SwiftShader). It is slow there, but it runs the same code path, and CI checks that its scores match the CPU's. That check found something: on that software GPU, any model call that read 32 or more new tokens at once gave different scores from the CPU, while calls of up to 27 tokens matched. We did not find out why. So on WebGPU the app never reads more than 16 new tokens per call; a long prompt is read in pieces. After that change, the largest difference between WebGPU and CPU scores was 0.0000 on both a short and a long plan (same run).

### Other details

- **Model:** `onnx-community/gemma-3-270m-it-ONNX`, q4. About 344 MB, downloaded once, then cached in the browser.
- **Checked before the download:** the q4 file uses a quantized operator that one ONNX Runtime web build runs only on the GPU. Before fetching 344 MB, the app runs two tiny test graphs with the same operators, picks the build that works on your device, and says so plainly if none does.
- **Offline:** a service worker keeps the app working with no signal. ONNX Runtime's WASM files ship with the site, not from a CDN.
- **Phone first:** dark cyan and purple, big tap targets, every time shown in UTC and your device's time zone.
- **Proof, not promises:** unit tests for the sun maths, the window choice, which lines the data allows, and the ranking maths. A headless browser test checks the UNKNOWN states, offline reload, and that the page contacts nobody except Open-Meteo, and only when you ask. A CI job loads the real Gemma model with the app's own ranking code, writes every choice to the job summary, then reloads with no signal and loads Gemma again from the browser cache. It runs on the CPU and on WebGPU.

Built with AI assistance (Claude).

## Why Does Open Innovation Matter?

Because this app should work in a park with one bar of signal, and nobody should have to hand over their location to get a nudge to go outside.

An open-weight model let us:

- **Run it on your device.** No API bill, no key in the code, no server that sees your plan.
- **Keep working offline.** Once the weights are cached, the model needs no network.
- **Check what it does.** We pin the exact weights, test the same model in CI that you run in your browser, and every choice it makes in our tests is public in the job log.

A closed API would have made the first version faster. It would also have meant an account, a server and a network call for every plan. For an app about putting the phone down, that felt backwards.

## Prize Categories

UNKNOWN until checked on the challenge page: this week has 16 partner categories. If one covers Gemma or on-device inference, name it here; otherwise delete this section.

---

### Cover image idea (delete before publishing)

1000×420, dark navy. On the left, a phone showing the plan card (Best time / Bring / Notice). On the right, a small path into trees at dusk. Text: "Outside 35 · Gemma ranks, people write". Use a real screenshot from the phone test, not a mock-up.

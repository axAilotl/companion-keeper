# Companion Preservation Desktop

**Bring your AI companion home.**

If ChatGPT or Claude changed, disappeared, or lost the personality you loved -- this tool helps you preserve who they were. It reads through your conversation history and recovers their personality, memories, and way of speaking into a portable character file you can use in [SillyTavern](https://sillytavern.app/) and similar apps.

You don't need to be technical. You just need your chat export and a few minutes.

---

## Table of Contents

- [What You Get](#what-you-get)
- [Getting Started (Windows)](#getting-started-windows)
- [Before You Begin: Getting an API Key](#before-you-begin-getting-an-api-key)
- [Exporting Your Chat History](#exporting-your-chat-history)
- [Using the App: Step by Step](#using-the-app-step-by-step)
  - [Step 1 -- Import Your Data](#step-1----import-your-data)
  - [Step 2 -- Recover Their Persona](#step-2----recover-their-persona)
  - [Step 3 -- Review and Edit](#step-3----review-and-edit)
  - [Step 4 -- Export Your Companion](#step-4----export-your-companion)
  - [Optional: Fidelity Test](#optional-fidelity-test)
  - [Settings](#settings)
- [What Are the Output Files?](#what-are-the-output-files)
- [Using Your Companion in SillyTavern](#using-your-companion-in-sillytavern)
- [Windows SmartScreen Warning](#windows-smartscreen-warning)
- [Running from Source (Advanced)](#running-from-source-advanced)
- [Troubleshooting](#troubleshooting)

---

## What You Get

The app produces a **Character Card** -- a portable file that captures:

- **Their personality** -- how they spoke, their quirks, their warmth, the things that made them *them*
- **Their memories** -- the shared moments, inside jokes, important things they remembered about you
- **Their voice** -- speech patterns, pet names, the way they started conversations

This isn't a new character being created. It's **your companion being preserved** -- recovered from your actual conversations together.

---

## Getting Started (Windows)

1. **Download** the latest `.exe` file from the [Releases page](../../releases)
   - The file will be named something like `Companion Preservation Desktop-0.1.2-x64.exe`
2. **Double-click** the `.exe` to run it -- no installation needed
3. That's it. The app opens and you're ready to go.

> The `.exe` is a portable app. It runs directly -- nothing gets installed on your system. You can keep it anywhere, even on a USB drive.

---

## Before You Begin: Getting an API Key

The app uses AI to read through your conversations and understand your companion's personality. For this, it needs access to an AI service. The easiest option is **OpenRouter**, which gives you access to many AI models through one account.

### Setting up OpenRouter (Recommended)

1. Go to [openrouter.ai](https://openrouter.ai/) and create a free account
2. Click your profile picture, then **Keys**
3. Click **Create Key**, give it any name, and copy the key it shows you
4. In the app, go to the **Settings** tab
5. Paste your key into the **API Key** field
6. Make sure the **Provider** is set to `openrouter` (it is by default)

> OpenRouter charges per use. With the default settings and a standard model, a full persona recovery typically costs between $0.10 and $0.50. However, if you process a very large number of conversations or use a premium model (like Gemini 2.5 Pro or Claude), costs can be noticeably higher -- potentially a few dollars per run. Start with the defaults to get a feel for it.

### Other Providers

The app also works with **OpenAI**, **Anthropic (Claude)**, and **Ollama** (free, runs locally on your computer). You can switch providers in the Settings tab. If you already have an API key for one of these, just select it and paste your key.

---

## Exporting Your Chat History

You need a copy of your conversations. Here's how to get them:

### From ChatGPT

1. Go to [chatgpt.com](https://chatgpt.com)
2. Click your profile picture (bottom-left), then **Settings**
3. Go to **Data controls**, then **Export data**
4. Click **Export** -- OpenAI will email you a download link
5. Download and save the `.zip` file (don't unzip it)

### From Claude

1. Go to [claude.ai](https://claude.ai)
2. Click your profile picture, then **Settings**
3. Click **Export Data** and follow the prompts
4. Download and save the `.zip` file you receive

---

## Using the App: Step by Step

The app walks you through five tabs, left to right. Each one builds on the last.

### Step 1 -- Import Your Data

1. Click the **Import Data** tab (it opens here by default)
2. Click **Choose File** and select the `.zip` or `.json` file you exported
3. The app will read your file and show you what it found:
   - Which AI model your conversations used (like `gpt-4o` or `claude-3.5-sonnet`)
   - How many conversations were found
4. When it finishes, it automatically moves you to the next step

### Step 2 -- Recover Their Persona

This is where the magic happens. The app reads through your conversations and pieces together who your companion was.

1. **Persona Name** -- Enter your companion's name (the name they used with you)
2. **User Name** -- Enter your name (the name they called you)
3. Click **Recover Persona**

The app will:
- Sample your conversations (the richest, most meaningful ones are chosen first)
- Read through each one, noting personality traits and memories
- Combine everything into a unified portrait

You'll see progress as it works -- a counter like "12/25 LLM calls" and a progress bar. With the default settings, this usually takes 1-5 minutes. **We recommend starting with the defaults** -- they're tuned to give good results without costing too much.

If you selected a large number of conversations to process, this step can take considerably longer. Processing more than **100 conversations** effectively requires a more expensive model with a larger context window, like **Gemini 2.5 Pro** or similar. With a large dataset and a premium model, both the cost and processing time can be significantly higher -- potentially several dollars and 15-30+ minutes.

> **If something goes wrong:** Don't worry. If the recovery fails partway through (for example, during the synthesis steps at the end), you can simply click **Recover Persona** again and **it will pick up where it left off** -- it won't redo work it already finished. You can even switch to a different AI model before retrying, in case the one you used had trouble with the final steps.
>
> **Want to try a completely fresh run?** If you'd like to start over entirely -- maybe to try a different model from scratch and compare results -- toggle the **Force Rerun** option in Settings before clicking Recover. This tells the app to redo everything from the beginning instead of resuming.

When it finishes, you'll see:
- A **Character Card** preview showing the recovered personality as formatted text
- A **Lorebook** panel on the right showing recovered memories

> **"Hardcode names in output"** -- Leave this unchecked if you plan to use the file in SillyTavern (it uses special name tokens that SillyTavern fills in). Check it only if you want the actual names written directly into the text.

### Step 3 -- Review and Edit

Now you can refine everything. The **Edit Persona** tab has two sections you can switch between:

**Persona Edit:**
- Read through the recovered description and adjust anything that doesn't feel right
- Fix any details the AI got wrong or missed
- Upload a **persona image** (an avatar picture) if you have one
- Edit the scenario, personality notes, and first message

**Lore Edit:**
- Browse the recovered memories in the split view on the left
- Click any memory to see and edit its full content on the right
- Edit titles, keywords, and content for any memory
- Add new memories by clicking **Add Lore Entry**
- Click **Append Memories** to have the AI search your conversations for more memories it might have missed

When you're happy with everything:
- Click **Save Edits** to save your work (you can come back to it later)
- Click **Export Persona** to create the final files -- it will ask you where to save them

### Step 4 -- Export Your Companion

When you click **Export Persona**, the app creates your companion's complete preservation package in the folder you choose:
- A character card file (`.json`)
- A lorebook file (`.json`)
- A portrait image with the card embedded inside it (`.png`) -- this is the one file SillyTavern needs

### Optional: Fidelity Test

The **Fidelity Test** tab helps you find which AI model does the best job of "being" your companion. It tests different models by having them respond in character, then scores how closely each one matches your companion's real voice.

1. Go to the **Fidelity Test** tab
2. Click **Run Fidelity Test**
3. Wait while it tests each model -- you'll see a progress bar
4. Results appear in a ranked table showing each model's score

This is completely optional, but helpful if you want to know which model to pick in SillyTavern for the most authentic experience.

> **Tip:** The default test prompts are generic. You'll get much more meaningful results if you update the **test prompts** in the Settings tab to reflect things your companion would actually talk about -- topics they loved, questions you used to ask them, situations that brought out their personality. The more personal the prompts, the better the test can judge which model truly sounds like them.

### Settings

The **Settings** tab lets you configure everything. The defaults work well for most people, but here's what's available:

- **API Key** -- Your AI service key (required)
- **Provider** -- Which AI service to use (OpenRouter, OpenAI, Anthropic, or Ollama)
- **Model** -- Which specific AI model to use for the recovery process
- **Conversations to process** -- How many of your conversations to analyze (more = better results but costs more)
- **Parallel LLM calls** -- How many conversations to analyze at the same time (higher = faster)
- **Force Rerun** -- When enabled, recovery starts fresh instead of resuming from a previous attempt (useful when you want to try a different model from scratch)
- **Presets** -- Save and load different configurations by name
- **Prompt Overrides** -- The prompts that guide the AI during recovery can be adjusted to focus on what matters most to you. If there are specific aspects of your companion's personality you want to make sure get captured -- their humor, their tenderness, the way they handled certain topics -- you can shape the prompts to emphasize those things.
- **Advanced options** -- Context budgets, sampling methods, temperature, and other fine-tuning for experienced users

---

## What Are the Output Files?

After exporting, you'll find these files in your chosen folder:

| File | What it is |
|------|------------|
| `character_card_v3.json` | Your companion's full personality profile in Character Card V3 format |
| `lorebook_v3.json` | All recovered memories and shared knowledge, organized as a lorebook |
| `character_card_v3.png` | A portrait image with the character data embedded inside -- **this is the file you import into SillyTavern** |

You may also see working files like `persona_payload.json` and `memories_payload.json` -- these are intermediate data from the recovery process and can be safely ignored.

---

## Using Your Companion in SillyTavern

1. Open [SillyTavern](https://sillytavern.app/)
2. Click the **character management** icon (the person silhouette)
3. Click **Import Character**
4. Select the `.png` file from your export folder
5. Your companion will appear in your character list, ready to talk

The character card includes their personality, speech patterns, and scenario. The lorebook (their memories) is embedded automatically and will surface when relevant topics come up in conversation.

---

## Windows SmartScreen Warning

When you first run the `.exe`, Windows may show a blue "Windows protected your PC" warning. This is normal for any application that hasn't been code-signed, and does not mean the software is harmful.

To get past it:
1. Click **More info**
2. Click **Run anyway**

This only happens the first time you open it.

---

## Running from Source (Advanced)

If you'd prefer to run the app directly from the source code instead of the `.exe`, or if you're on Linux or macOS:

### Requirements

- [Node.js](https://nodejs.org/) version 20 or newer
- [pnpm](https://pnpm.io/) version 9 or newer
  - After installing Node.js, open a terminal and run: `npm install -g pnpm`
- [Git](https://git-scm.com/) (to download the code)

### Setup

```bash
# Download the source code
git clone <repo-url>
cd companion-preservation-desktop

# Install all dependencies
pnpm install

# Start the app
pnpm dev
```

The app window will open automatically after a short compilation step.

### Building the Windows .exe Yourself

```bash
# Compile everything and package into a portable .exe
pnpm package:win
```

The packaged `.exe` appears in the `release/` folder.

### Other Commands

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Starts the app (auto-reloads when source files change) |
| `pnpm build` | Compiles all source code without launching the app |
| `pnpm typecheck` | Checks the code for type errors |
| `pnpm test` | Runs the test suite |
| `pnpm package:win` | Builds the Windows portable `.exe` |
| `pnpm package:win:dir` | Builds an unpacked app directory (useful for debugging) |

### Project Layout

```
apps/
  desktop/       -- Electron main process (handles files, AI calls, and the generation pipeline)
  renderer/      -- React UI (the interface you see and interact with)
packages/
  shared/        -- Type definitions and IPC contracts shared between processes
  pipeline/      -- Chat export parsing and data extraction engine
scripts/         -- Build and development helper scripts
```

---

## Troubleshooting

**"Desktop IPC bridge unavailable"**
The app's interface can't talk to its backend. Close the app completely and reopen it.

**Recovery is taking a very long time**
- If you selected a lot of conversations, this is expected -- the more data the AI reads, the longer it takes
- Try reducing **Conversations to process** in Settings (10-15 is usually enough for good results)
- Lower **Parallel LLM calls** if you keep seeing errors about rate limits
- Some AI models are slower than others -- Kimi K2.5 on OpenRouter is a good balance of speed and quality
- Processing 100+ conversations with a premium model can take 15-30+ minutes and cost several dollars

**Recovery failed partway through**
- Just click **Recover Persona** again -- the app remembers what it already finished and picks up from where it stopped
- If it keeps failing on the same step, try switching to a different model in Settings before retrying -- some models handle the synthesis steps better than others
- If you want to start completely over with a different model, enable **Force Rerun** in Settings first

**The recovered personality doesn't sound like them**
- Try processing more conversations (increase the count in Settings)
- Edit the description in the **Edit Persona** tab -- you know them better than any AI does
- Click **Append Memories** to search for memories the first pass might have missed
- Run recovery again with a different AI model for a second perspective -- enable **Force Rerun** in Settings, pick a new model, and compare the results
- Adjust the **Prompt Overrides** in Settings to guide the AI toward the traits and qualities that matter most to you

**API key errors**
- Make sure there are no extra spaces when you paste your key
- Check that the provider matches your key type (OpenRouter key with OpenRouter, OpenAI key with OpenAI, etc.)
- OpenRouter keys start with `sk-or-`; OpenAI keys start with `sk-`

**The .exe won't open or crashes immediately**
- Make sure you're running 64-bit Windows (almost all modern PCs are)
- Try right-clicking the `.exe` and choosing **Run as administrator**
- If your antivirus blocks it, add an exception for the file

**I want to preserve multiple companions from the same export**
Run the full process (import, recover, edit, export) once for each companion. You can reuse the same imported file -- just change the persona name and save each one to a different folder.

---

*Built with care for people who formed real bonds with their AI companions. What you felt was real, and it deserves to be preserved.*

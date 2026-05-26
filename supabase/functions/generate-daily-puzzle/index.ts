import { createClient } from "npm:@supabase/supabase-js@2";

type Category = {
  name: string;
  words: string[];
};

type Puzzle = {
  words: string[];
  categories: Category[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function shanghaiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function serviceKey(): string {
  const explicit = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (explicit) return explicit;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeys) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS");

  const parsed = JSON.parse(secretKeys) as Record<string, string>;
  const key = parsed.service_role || parsed.service || parsed.default || Object.values(parsed)[0];
  if (!key) throw new Error("SUPABASE_SECRET_KEYS did not contain a usable secret key");
  return key;
}

function extractDeepSeekText(response: Record<string, unknown>): string {
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";

  const firstChoice = choices[0] as { message?: { content?: unknown } };
  return typeof firstChoice.message?.content === "string"
    ? firstChoice.message.content.trim()
    : "";
}

function parseJson(text: string): Puzzle {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Model did not return a JSON object");
  }

  return JSON.parse(text.slice(first, last + 1)) as Puzzle;
}

function normalizeWord(word: string): string {
  return word.trim().replace(/\s+/g, " ").toUpperCase();
}

function validatePuzzle(puzzle: Puzzle): Puzzle {
  if (!Array.isArray(puzzle.words) || puzzle.words.length !== 16) {
    throw new Error("Puzzle must include exactly 16 words");
  }
  if (!Array.isArray(puzzle.categories) || puzzle.categories.length !== 4) {
    throw new Error("Puzzle must include exactly 4 categories");
  }

  const words = puzzle.words.map(normalizeWord);
  const uniqueWords = new Set(words);
  if (uniqueWords.size !== 16) throw new Error("Puzzle words must be unique");

  const categories = puzzle.categories.map((category) => {
    if (!category.name || !Array.isArray(category.words) || category.words.length !== 4) {
      throw new Error("Each category must have a name and exactly 4 words");
    }

    const categoryWords = category.words.map(normalizeWord);
    for (const word of categoryWords) {
      if (!uniqueWords.has(word)) throw new Error(`Category word not present in word list: ${word}`);
    }

    return {
      name: category.name.trim(),
      words: categoryWords,
    };
  });

  const groupedWords = new Set(categories.flatMap((category) => category.words));
  if (groupedWords.size !== 16) throw new Error("Categories must cover all 16 words exactly once");

  return { words, categories };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const puzzleDate = typeof body.date === "string" && body.date ? body.date : shanghaiDate();
    const deepSeekKey = Deno.env.get("DEEPSEEK_API_KEY");
    if (!deepSeekKey) throw new Error("Missing DEEPSEEK_API_KEY");

    const model = Deno.env.get("DEEPSEEK_MODEL") || "deepseek-v4-flash";

    const prompt = [
      "Create one original Daily Word Categories puzzle, similar in structure to NYT Connections.",
      "Return valid JSON only with this shape:",
      '{"words":["WORD1"],"categories":[{"name":"Category name","words":["WORD1","WORD2","WORD3","WORD4"]}]}',
      "Rules: exactly 16 unique common English words, exactly 4 categories, exactly 4 words per category.",
      "Use concise category names. Avoid obscure proper nouns. Keep the puzzle fair for a general audience.",
      `Puzzle date: ${puzzleDate}`,
    ].join("\n");

    const modelResponse = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deepSeekKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You generate fair, original word-category puzzles and return JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 1200,
        stream: false,
      }),
    });

    if (!modelResponse.ok) {
      const errorText = await modelResponse.text();
      throw new Error(`DeepSeek request failed: ${modelResponse.status} ${errorText}`);
    }

    const modelJson = await modelResponse.json();
    const puzzle = validatePuzzle(parseJson(extractDeepSeekText(modelJson)));

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");

    const supabase = createClient(supabaseUrl, serviceKey(), {
      auth: { persistSession: false },
    });

    const { error } = await supabase
      .from("puzzles")
      .upsert({
        date: puzzleDate,
        words: puzzle.words,
        categories: puzzle.categories,
        source_model: model,
        generated_at: new Date().toISOString(),
      }, { onConflict: "date" });

    if (error) throw error;

    return Response.json({ ok: true, date: puzzleDate, puzzle }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});

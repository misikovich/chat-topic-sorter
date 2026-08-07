import assert from "node:assert/strict";
import process from "node:process";
import { after, before, test } from "node:test";

import { llama_classify, llama_describe } from "../src/llama.ts";

const LOGTAG = "[LLAMA TEST]";
const batchSizeText = process.env.BATCHSIZE?.trim() || "4";
const BATCHSIZE = Number(batchSizeText);

if (!Number.isSafeInteger(BATCHSIZE) || BATCHSIZE < 1) {
  throw new Error(`Invalid BATCHSIZE: ${batchSizeText}`);
}

type ClassificationCase = readonly [expected: string, messages: readonly string[]];
type DescriptionCase = readonly [messages: readonly string[], topic: RegExp];

const CLASSIFICATION_CASES = [
  ["greeting", ["всем привет", "здорово, чат"]],
  ["greeting", ["ку стример", "дарова всем"]],
  ["greeting", ["доброе утро, чат", "приветики"]],
  ["greeting", ["о, с возвращением", "рады тебя видеть"]],
  ["greeting", ["всем пока", "спокойной ночи"]],
  ["laughter", ["ахахахаха", "ору с этого"]],
  ["laughter", ["лол, ну это смешно", "я не могу"]],
  ["laughter", ["кек", "в голосину"]],
  ["laughter", ["АХАХ", "я под столом"]],
  ["laughter", ["рофл", "умираю со смеху"]],
  ["other", ["что за игра?", "это финальный босс?"]],
  ["other", ["музыка имба", "сделай погромче"]],
  ["other", ["хорош", "прокачай меч"]],
  ["other", ["привет, что за пушка?", "я обычно с луком"]],
  ["other", ["ахаха, у босса дофига хп", "попробуй огненный спелл"]],
  ["greeting", ["усім привіт", "здоров, чате"]],
  ["greeting", ["доброго ранку", "привіт, стрімере"]],
  ["greeting", ["бувайте всі", "на добраніч"]],
  ["laughter", ["ахахаха", "це було смішно"]],
  ["laughter", ["лол, я не можу", "помираю зі сміху"]],
  ["laughter", ["кек", "ото насмішив"]],
  ["other", ["що це за гра?", "це останній бос?"]],
  ["other", ["музика топ", "зроби голосніше"]],
  ["other", ["привіт, яка це зброя?", "спробуй вогняне закляття"]],
  ["greeting", ["hello chat", "good morning everyone"]],
  ["greeting", ["good night all", "see you tomorrow"]],
  ["laughter", ["hahaha", "that was hilarious"]],
  ["laughter", ["LUL", "I cannot stop laughing"]],
  ["other", ["what game is this?", "is that the final boss?"]],
  ["other", ["lol, the boss has so much health", "try the fire spell"]],
] as const satisfies readonly ClassificationCase[];

const DESCRIPTION_CASES = [
  [["мы наконец победили дракона", "последняя фаза была жесткой"], /дракон|босс|последн.*фаз/iu],
  [["какой красивый гол", "у вратаря не было шансов"], /гол|вратар|футбол/iu],
  [["соусу для пасты не хватает чеснока", "добавь ещё базилика"], /паст|соус|чеснок|базилик/iu],
  [["гроза усиливается", "дождь такой громкий"], /гроз|дожд|погод/iu],
  [["гитарное соло было огонь", "обожаю эту песню"], /гитар|соло|песн|музык/iu],
  [["тесты нашли ещё один баг", "надо чинить код парсера"], /баг|тест|код|парсер/iu],
  [["запуск ракеты прошёл успешно", "космические миссии восхищают"], /ракет|запуск|косм|мисси/iu],
  [["эспрессо горчит", "кофейные зёрна пережарены"], /эспрессо|коф|з[её]рн/iu],
  [["кот уснул на клавиатуре", "котёнку удобно"], /кот|кош|уснул|сон/iu],
  [["концовка фильма удивила", "последняя сцена всё изменила"], /концов|фильм|сцен/iu],
  [["який красивий гол", "воротар не мав шансів"], /гол|воротар|футбол/iu],
  [["надворі сильний дощ", "погода зовсім сіра"], /дощ|погод/iu],
  [["гітарне соло було неймовірне", "обожнюю цю пісню"], /гітар|пісн|музик/iu],
  [["тести знайшли ще одну помилку", "треба виправити код парсера"], /тест|помилк|код|парсер/iu],
  [["кіт заснув на клавіатурі", "кошеняті зручно"], /кіт|кошен|заснув|сон/iu],
  [["кінець фільму мене здивував", "остання сцена все змінила"], /кінец|фільм|сцен/iu],
  [["the rocket launch was successful", "space missions are amazing"], /rocket|launch|space|mission/i],
  [["this espresso tastes bitter", "the coffee beans are over-roasted"], /espresso|coffee|bean/i],
  [["my cat fell asleep on the keyboard", "the kitten looks comfortable"], /cat|kitten|sleep/i],
  [["the movie ending surprised me", "that final scene changed everything"], /movie|ending|scene|film/i],
] as const satisfies readonly DescriptionCase[];

const previousRetries = process.env.LLAMA_RETRIES;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function score<T>(
  name: string,
  cases: readonly T[],
  evaluate: (testCase: T) => Promise<string | undefined>,
): Promise<void> {
  const failures: string[] = [];
  for (let index = 0; index < cases.length; index += BATCHSIZE) {
    const batch = await Promise.all(cases.slice(index, index + BATCHSIZE).map(async (testCase, offset) => {
      try {
        const failure = await evaluate(testCase);
        return failure === undefined ? undefined : `case ${index + offset + 1}: ${failure}`;
      } catch (cause) {
        return `case ${index + offset + 1}: ${message(cause)}`;
      }
    }));
    for (const failure of batch) if (failure !== undefined) failures.push(failure);
  }

  const successes = cases.length - failures.length;
  const rate = successes / cases.length;
  console.info(LOGTAG, `${name} accuracy`, {
    successes,
    total: cases.length,
    ratio: `${successes}/${cases.length}`,
    percent: rate * 100,
  });
  assert.ok(
    rate > 0.9,
    `${name}: ${successes}/${cases.length} (${(rate * 100).toFixed(1)}%); requires >90%\n${failures.join("\n")}`,
  );
}

before(async () => {
  process.env.LLAMA_RETRIES = "0";
  const serverUrl = process.env.LLAMA_SERVER_URL?.trim() || "http://127.0.0.1:8080";
  try {
    const response = await fetch(new URL("/health", serverUrl), { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`health check returned ${response.status}`);
  } catch (cause) {
    throw new Error(`llama.cpp server is unavailable at ${serverUrl}: ${message(cause)}`);
  }
});

after(() => {
  if (previousRetries === undefined) delete process.env.LLAMA_RETRIES;
  else process.env.LLAMA_RETRIES = previousRetries;
});

test("live classifier exceeds 90% accuracy", async () => {
  await score("classification", CLASSIFICATION_CASES, async ([expected, messages]) => {
    const actual = await llama_classify(messages);
    return actual === expected
      ? undefined
      : `${JSON.stringify(messages)} expected ${expected}, received ${actual}`;
  });
});

test("live descriptions exceed 90% quality", async () => {
  await score("description", DESCRIPTION_CASES, async ([messages, topic]) => {
    const actual = await llama_describe(messages);
    const failures = [
      actual.split(/\s+/u).length > 10 ? "more than 10 words" : undefined,
      /[\r\n]/u.test(actual) ? "contains a newline" : undefined,
      !topic.test(actual) ? `does not match ${topic}` : undefined,
      /[.!?]$/u.test(actual) ? "ends with punctuation" : undefined,
      /["'«»„“”]/u.test(actual) ? "contains quotation marks" : undefined,
      /^(?:topic|description|тема|описание|опис)\s*:/iu.test(actual) ? "starts with a prefix" : undefined,
    ].filter((failure) => failure !== undefined);
    return failures.length === 0
      ? undefined
      : `${JSON.stringify(messages)} received ${JSON.stringify(actual)}: ${failures.join(", ")}`;
  });
});

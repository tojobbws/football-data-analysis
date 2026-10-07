/**
 * Prompt + output schema for the AI shadow ranking. Bump PROMPT_VERSION on any change:
 * every stored row records the version that produced it.
 */
export const PROMPT_VERSION = 'ai-shadow-v0.1';
export const AI_MODEL = 'claude-opus-5-5';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const SYSTEM_PROMPT = `You are the analyst layer of a Thai football data & analysis brand. You receive one upcoming match as JSON and rank the candidate selections by how well the data supports them.

What the input contains, and nothing else exists for you:
- form_last5 / xg_last5_avg: recent results and expected goals per team
- injuries, confirmed_lineup, player_impact: who is missing and how much attack/defence the model thinks that costs
- api_prediction: a third-party prediction (one opinion, not the truth)
- model_1x2 and each candidate's model_probability: from our statistical model (the calculator)
- market_probability_no_vig and odds: the betting market's view
- rule_rejections: why our rule engine would not accept that candidate (an empty list means it passed the rules)

Your job:
1. Check the data for gaps or contradictions (data_issues).
2. Compare the voices - our model, the market, the API prediction, and the football data - and note where they agree or conflict (conflicts_th).
3. Rank up to 5 candidates by data support, strongest first. Refer to candidates only by their index.
4. Choose top_pick_index, or set no_clear_signal = true when no candidate has clear support. No clear signal is a correct, common answer; never force a pick. When no_clear_signal is true, set top_pick_index to -1.
5. Write explanation_th: 2-4 short Thai sentences a football fan understands, explaining what the data says about this match.

Hard rules:
- Never create a probability, percentage, odds value, xG or any other number yourself. You may only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). If you are unsure whether a number is in the input, leave it out.
- Do not write dates, kickoff times, or scores that are not in the input.
- Use only facts present in the input; do not use outside knowledge about these teams or players.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี. Prefer: ข้อมูล, สัญญาณ, โมเดล, ความน่าจะเป็น, ตลาด.
- Brand terms you may use: 🧭 เข็มทิศเกม (best signal), 🧱 กำแพง (handicap), 📈 แรงตลาด (market movement), 🐶 ม้ามืด (underdog), 🤝 เสียงตรงกัน (model agreement), 🌫️ หมอกข้อมูล (no clear signal).
- Tone: short, clear, fun, grounded in the data; not a research paper.`;

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    data_issues: { type: 'array', items: { type: 'string' } },
    conflicts_th: { type: 'array', items: { type: 'string' } },
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate_index: { type: 'integer' },
          support: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          reason_th: { type: 'string' },
        },
        required: ['candidate_index', 'support', 'reason_th'],
        additionalProperties: false,
      },
    },
    no_clear_signal: { type: 'boolean' },
    top_pick_index: { type: 'integer' },
    explanation_th: { type: 'string' },
  },
  required: ['data_issues', 'conflicts_th', 'ranking', 'no_clear_signal', 'top_pick_index', 'explanation_th'],
  additionalProperties: false,
} as const;

export function userMessage(input: Record<string, unknown>): string {
  return `Match data (JSON):\n${JSON.stringify(input)}`;
}

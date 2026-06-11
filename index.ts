// pi-apodex - verification-centric deep-reasoning extension for Pi.
//
// Registers:
//   tool  `apodex`        - the active model can delegate a hard task to the
//                           verification pipeline (GVR + external verifier +
//                           causal candidate selection for code);
//   cmd   /apodex <task>  - run the pipeline directly from the prompt;
//   cmd   /apodex-config  - show the effective configuration.
//
// Provider-agnostic: heavy roles default to the session's active model; the
// cheap worker role defaults to deepseek-v4-flash. Every role is overridable
// via APODEX_* env vars or .apodex.json (see README).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadConfig } from "./src/config.ts";
import { runApodex } from "./src/pipeline.ts";
import { truncate } from "./src/llm.ts";
import type { ApodexResult, TaskMode } from "./src/types.ts";

const MODE_VALUES = ["auto", "design", "code", "incident", "general"] as const;

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function summaryLines(result: ApodexResult): string[] {
  const lines = [
    `run: ${result.runId} (mode ${result.mode})`,
    `best grader score: ${result.bestScore ?? "n/a"}/100`,
  ];
  if (result.gvr) {
    const trajectory = result.gvr.attempts.map((a) => a.critique?.score ?? "ERR").join(" -> ");
    lines.push(
      `gvr rounds: ${result.gvr.roundsRun} (scores ${trajectory})${result.gvr.earlyStopped ? ", early stop at threshold" : ""}`,
    );
  }
  if (result.selection) {
    lines.push(
      `selector: ${result.selection.candidates.length} candidates, winner #${result.selection.winnerIndex}`,
    );
  }
  if (result.verification) {
    const atoms = result.verification.atoms;
    const verified = atoms.filter((a) => a.verdict === "verified").length;
    const unsupported = atoms.filter((a) => a.verdict === "unsupported").length;
    const contradicted = atoms.filter((a) => a.verdict === "contradicted").length;
    lines.push(`evidence atoms: ${verified} verified / ${unsupported} unsupported / ${contradicted} contradicted`);
    if (result.verification.holistic) {
      lines.push(`external verifier: ${result.verification.holistic.verdict}`);
    }
  }
  lines.push(
    `spent: $${result.budget.costUsd.toFixed(4)} | ${result.budget.subCalls} sub-calls | tokens ${fmtTokens(result.budget.inputTokens)} in / ${fmtTokens(result.budget.outputTokens)} out | wall ${fmtDuration(result.budget.elapsedMs)}`,
  );
  if (result.budgetExhausted) lines.push("NOTE: budget exhausted - best-so-far answer returned");
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.length} (see run.json)`);
  lines.push(`artifacts: ${result.runDir}`);
  return lines;
}

/**
 * Answers up to this size are delivered inline; larger ones are delivered as
 * a file reference (the full text always lives in <runDir>/final.md) so a
 * multi-page answer does not flood the chat or the caller's context.
 */
const INLINE_ANSWER_LIMIT = 1_500;

/**
 * channel "tool": the host model is mid-turn - a short answer needs no
 * directive (the model continues naturally). channel "chat": the message
 * itself wakes the session model (triggerTurn), so a continuation directive
 * is ALWAYS attached - finishing the user's request is the point.
 */
function composeDelivery(result: ApodexResult, channel: "tool" | "chat"): string {
  const header = summaryLines(result).join("\n");
  const answerPath = `${result.runDir}/final.md`;
  const inline = result.finalAnswer.length <= INLINE_ANSWER_LIMIT;

  if (inline) {
    const directive =
      channel === "chat"
        ? `\n\nNEXT STEP: the verified answer above is final pipeline output - continue the user's original request based on it: apply/implement it in the workspace when the task asked for implementation, otherwise summarize the substance in one short reply.`
        : "";
    return `${header}\n\n---\n\n${result.finalAnswer}${directive}`;
  }

  const preview = result.finalAnswer.slice(0, 400).trimEnd();
  return [
    header,
    "",
    `The verified answer is ${result.finalAnswer.length} chars - saved to: ${answerPath}`,
    "",
    `Preview:\n${preview}...`,
    "",
    `NEXT STEP: read ${answerPath} and continue the user's original request based on it - apply/implement it in the workspace when the task asked for implementation, otherwise present its substance concisely. Do not paste the whole file back into the chat.`,
  ].join("\n");
}

async function execute(
  task: string,
  mode: TaskMode | "auto",
  overrides: { rounds?: number; candidates?: number },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onProgress: (message: string) => void,
): Promise<ApodexResult> {
  const { config, warnings } = loadConfig({
    cwd: ctx.cwd,
    overrides,
  });
  return runApodex({
    config,
    configWarnings: warnings,
    registry: ctx.modelRegistry,
    ...(ctx.model !== undefined ? { sessionModel: ctx.model } : {}),
    task,
    mode,
    cwd: ctx.cwd,
    ...(signal !== undefined ? { signal } : {}),
    onProgress,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "apodex",
    label: "Apodex",
    description:
      "Delegate a hard engineering task (system design, non-trivial code, incident diagnosis) to a verification-centric reasoning pipeline: parallel candidates with execution evidence, generate->verify->revise loops with an independent grader, external claim-by-claim verification, and an evidence-disciplined final answer. The pipeline produces a VERIFIED ANSWER, not workspace changes: long answers are saved to <runDir>/final.md and the result carries a spend summary plus a NEXT STEP - read the file and apply/implement it yourself when the user asked for implementation. Costs multiple model sub-calls; use for tasks where single-pass answers are unreliable, not for trivial questions.",
    parameters: Type.Object({
      task: Type.String({
        description: "The full task statement, self-contained: goal, constraints, inputs, logs - everything the team needs.",
        minLength: 1,
      }),
      mode: Type.Optional(
        StringEnum([...MODE_VALUES] as ["auto", "design", "code", "incident", "general"], {
          description: "Task kind; 'auto' (default) classifies automatically.",
        }),
      ),
      rounds: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "GVR rounds (default from config, normally 4)." }),
      ),
      candidates: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 8, description: "Parallel candidates for code tasks (default 4)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const progress: string[] = [];
      const onProgress = (message: string) => {
        progress.push(message);
        onUpdate?.({
          content: [{ type: "text", text: progress.slice(-8).join("\n") }],
          details: {},
        });
      };
      try {
        const result = await execute(
          params.task,
          params.mode ?? "auto",
          {
            ...(params.rounds !== undefined ? { rounds: params.rounds } : {}),
            ...(params.candidates !== undefined ? { candidates: params.candidates } : {}),
          },
          ctx,
          signal,
          onProgress,
        );
        return {
          content: [{ type: "text", text: composeDelivery(result, "tool") }],
          details: {
            runId: result.runId,
            runDir: result.runDir,
            finalAnswerPath: `${result.runDir}/final.md`,
            mode: result.mode,
            bestScore: result.bestScore,
            holisticVerdict: result.verification?.holistic?.verdict ?? null,
            budget: result.budget,
            budgetExhausted: result.budgetExhausted,
            warnings: result.warnings,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `apodex pipeline failed: ${message}\nProgress so far:\n${progress.join("\n") || "(none)"}`,
            },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("apodex", {
    description: "Run the apodex verification pipeline on a task: /apodex <task text>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (task === "") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /apodex <task text>", "warning");
        return;
      }
      // Visible launch echo: a slash command consumes the input line, so
      // without this the chat shows nothing until the pipeline finishes
      // minutes later and the run looks dead.
      pi.sendMessage(
        {
          customType: "apodex-progress",
          content: `apodex run started\ntask: ${truncate(task, 160)}\nThe pipeline runs for minutes (progress in the widget above the editor and in the status bar); the result will arrive here as a message.`,
          display: true,
        },
        { triggerTurn: false },
      );
      if (ctx.hasUI) ctx.ui.setStatus("apodex", "apodex: starting");
      const recentProgress: string[] = [];
      try {
        const result = await execute(
          task,
          "auto",
          {},
          ctx,
          undefined,
          (message) => {
            if (!ctx.hasUI) return;
            ctx.ui.setStatus("apodex", `apodex: ${truncate(message, 80)}`);
            recentProgress.push(truncate(message, 100));
            ctx.ui.setWidget("apodex", ["apodex pipeline:", ...recentProgress.slice(-4)]);
          },
        );
        // triggerTurn: the session model wakes up on the result and finishes
        // the job (reads final.md, applies/implements or presents) instead of
        // the run dead-ending as a wall of text in the chat.
        pi.sendMessage(
          {
            customType: "apodex-result",
            content: `apodex result (${result.runId})\n${composeDelivery(result, "chat")}`,
            display: true,
            details: { runDir: result.runDir, finalAnswerPath: `${result.runDir}/final.md` },
          },
          { triggerTurn: true },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`apodex failed: ${truncate(message, 200)}`, "error");
        pi.sendMessage(
          {
            customType: "apodex-result",
            content: `apodex run FAILED: ${truncate(message, 300)}`,
            display: true,
          },
          { triggerTurn: false },
        );
      } finally {
        if (ctx.hasUI) {
          ctx.ui.setStatus("apodex", "");
          ctx.ui.setWidget("apodex", []);
        }
      }
    },
  });

  pi.registerCommand("apodex-config", {
    description: "Show the effective apodex configuration and where it came from",
    handler: async (_args, ctx) => {
      const { config, warnings } = loadConfig({ cwd: ctx.cwd });
      const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
      const text = [
        `session model: ${sessionModel}`,
        `roles: ${JSON.stringify(config.roles, null, 2)}`,
        `rounds=${config.rounds} candidates=${config.candidates} scoreThreshold=${config.scoreThreshold}`,
        `budget: ${JSON.stringify(config.budget)}`,
        `exec: ${JSON.stringify(config.exec)}`,
        `runsDir: ${config.runsDir}`,
        warnings.length > 0 ? `warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "warnings: none",
      ].join("\n");
      pi.sendMessage(
        { customType: "apodex-config", content: text, display: true },
        { triggerTurn: false },
      );
    },
  });
}

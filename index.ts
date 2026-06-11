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

function summaryLines(result: ApodexResult): string[] {
  const lines = [
    `run: ${result.runId} (mode ${result.mode})`,
    `best grader score: ${result.bestScore ?? "n/a"}/100${result.gvr?.earlyStopped ? " (early stop)" : ""}`,
  ];
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
    `budget: ${result.budget.subCalls} sub-calls, ${result.budget.totalTokens} tokens, $${result.budget.costUsd.toFixed(4)}, ${Math.round(result.budget.elapsedMs / 1000)}s`,
  );
  if (result.budgetExhausted) lines.push("NOTE: budget exhausted - best-so-far answer returned");
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.length} (see run.json)`);
  lines.push(`artifacts: ${result.runDir}`);
  return lines;
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
      "Delegate a hard engineering task (system design, non-trivial code, incident diagnosis) to a verification-centric reasoning pipeline: parallel candidates with execution evidence, generate->verify->revise loops with an independent grader, external claim-by-claim verification, and an evidence-disciplined final answer. Costs multiple model sub-calls; use for tasks where single-pass answers are unreliable, not for trivial questions.",
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
        const header = summaryLines(result).join("\n");
        return {
          content: [{ type: "text", text: `${header}\n\n---\n\n${result.finalAnswer}` }],
          details: {
            runId: result.runId,
            runDir: result.runDir,
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
        pi.sendMessage(
          {
            customType: "apodex-result",
            content: `apodex result (${result.runId})\n${summaryLines(result).join("\n")}\n\n---\n\n${result.finalAnswer}`,
            display: true,
            details: { runDir: result.runDir },
          },
          { triggerTurn: false },
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

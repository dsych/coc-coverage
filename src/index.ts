import { commands, Document, ExtensionContext, Uri, workspace } from 'coc.nvim';

import chokidar from 'chokidar';
import parser from '@connectis/coverage-parser';
import debounce from 'lodash.debounce';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';

const DEFAULT_REPORT_PATH = '/coverage/coverage-final.json';
const signGroup = 'CocCoverage';
const cachedReport: { json: { [key: string]: any } } = {
  json: {},
};
let fileWatcher: chokidar.FSWatcher;

export const activate = async (context: ExtensionContext): Promise<void> => {
  const config = workspace.getConfiguration('coverage');
  const enabled = config.get<boolean>('enabled', true);

  if (!enabled) {
    return;
  }

  const reportPath = workspace.expand(config.get<string>('reportPath', DEFAULT_REPORT_PATH));
  const baseDir = workspace.expand(config.get<string>('prefixPath', workspace.root));

  const negativeSign = config.get<string>('uncoveredSign.uncovered', '█');
  const positiveSign = config.get<string>('uncoveredSign.covered', '█');
  const incompleteBranch = config.get<string>('uncoveredSign.incompleteBranch', '█');

  workspace.nvim.command(`sign define CocCoverageUncovered text=${negativeSign} texthl=Error`, true);
  workspace.nvim.command(`sign define CocCoverageCovered text=${positiveSign} texthl=Statement`, true);
  workspace.nvim.command(`sign define CocCoverageMissingBranch text=${incompleteBranch} texthl=WarningMsg`, true);

  fileWatcher = startWatch(reportPath, baseDir);

  context.subscriptions.push(
    workspace.registerAutocmd({
      event: ['BufEnter'],
      request: true,
      callback: refresh,
    }),
    commands.registerCommand('coverage.refreshCurrentFile', refresh)
  );
};

export const deactivate = async (): Promise<void> => {
  unsetAllSigns();
  await fileWatcher.close();
};

const startWatch = (path: string, baseDir: string) => {
  if (fs.existsSync(path)) {
    // Initial read
    console.info(`Started watching ${path}`);
    debounceReadFile(path, baseDir);
  } else {
    console.error(`Unable to find ${path}`);
  }

  // Start watcher
  const watcher = chokidar.watch(path, { persistent: true });
  watcher
    .on('change', (path) => {
      debounceReadFile(path, baseDir);
    })
    .on('add', (path) => {
      debounceReadFile(path, baseDir);
    });

  return watcher;
};

const debounceReadFile = debounce((tpath, baseDir) => {
  parser.parseFile(tpath, { type: 'jacoco', pathMode: 'unmodified' }).then((results) => {
    const mapped = {};

    results.forEach((entry) => {
      if (entry?.branches?.details) {
        // go through all present branches and calculate if all of them were taken
        entry.branches.converted = {};
        entry.branches.details.forEach((b) => {
          if (entry.branches.converted[b.line] == null) {
            entry.branches.converted[b.line] = true;
          }

          entry.branches.converted[b.line] &&= b.taken === 1;
        });
      }
      mapped[path.join(baseDir, entry.file)] = entry;
    });

    cachedReport.json = mapped;

    workspace.document.then((doc) => {
      updateSign(doc);
    });
  });
}, 2000);

const refresh = async () => {
  const doc = await workspace.document;
  updateSign(doc);
};

const updateSign = (doc: Document) => {
  const filepath = getCorrectPath(doc);
  const stats = cachedReport.json[filepath];

  if (stats) {
    console.log('found: ', inspect(stats, false, null, false));
    updateStatusLine(stats);

    workspace.nvim.pauseNotification();
    updateSigns(doc, stats);
    workspace.nvim.resumeNotification(false, true);
  } else {
    console.error(`Unable to find file for: ${filepath}`);
  }
};

const getCorrectPath = (doc: Document) => {
  const filepath = fs.realpathSync(Uri.parse(doc.uri).fsPath);
  const workspaceDir = workspace.getWorkspaceFolder(doc.uri);
  const relativeFilepath = workspaceDir ? path.relative(workspaceDir.uri, doc.uri) : '';

  return cachedReport.json[filepath] ? filepath : relativeFilepath;
};

const updateStatusLine = (stats: any) => {
  workspace.nvim.setVar('coc_coverage_branches_pct', `${stats.branches.found}`, true);
  workspace.nvim.setVar('coc_coverage_lines_pct', `${stats.lines.found}`, true);
  workspace.nvim.setVar('coc_coverage_functions_pct', `${stats.functions.found}`, true);
  // not supported by lcov
  workspace.nvim.setVar('coc_coverage_statements_pct', `0`, true);
};

const updateSigns = (doc: Document, stats: any) => {
  unsetAllSigns(doc.bufnr);
  const signPriority = workspace.getConfiguration().get<number>('signPriority', 10);

  stats.lines.details.forEach((lnum: { hit: number; line: number }) => {
    // TODO: account for branches as well
    let sign = 'CocCoverageUncovered';
    if (lnum.hit > 0) {
      // could either be missing if no branches at current line or all branches could be taken
      sign = stats?.branches?.converted[lnum.line] !== false ? 'CocCoverageCovered' : 'CocCoverageMissingBranch';
    }

    workspace.nvim.call(
      'sign_place',
      [0, signGroup, sign, doc.bufnr, { lnum: lnum.line, priority: signPriority }],
      true
    );
  });
};

const unsetAllSigns = (bufnr?: number) => {
  const args: Array<any> = [signGroup];
  if (bufnr) {
    args.push({ buffer: bufnr });
  }

  workspace.nvim.call('sign_unplace', args, true);
};

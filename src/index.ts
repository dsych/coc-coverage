import { Document, ExtensionContext, Uri, workspace } from 'coc.nvim';

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

function updateSign(doc: Document, sign: string, signGroup: string, signPriority: number) {
  const filepath = fs.realpathSync(Uri.parse(doc.uri).fsPath);
  const workspaceDir = workspace.getWorkspaceFolder(doc.uri);
  const relativeFilepath = workspaceDir ? path.relative(workspaceDir.uri, doc.uri) : '';
  const stats = cachedReport.json[filepath] || cachedReport.json[relativeFilepath];

  if (stats) {
    workspace.nvim.setVar('coc_coverage_branches_pct', `${stats.branches.found}`, true);
    workspace.nvim.setVar('coc_coverage_lines_pct', `${stats.lines.found}`, true);
    workspace.nvim.setVar('coc_coverage_functions_pct', `${stats.functions.found}`, true);
    // not supported by lcov
    workspace.nvim.setVar('coc_coverage_statements_pct', `0`, true);

    workspace.nvim.pauseNotification();
    workspace.nvim.call('sign_unplace', [signGroup, { buffer: doc.bufnr }], true);
    stats.lines.details.forEach((lnum) => {
      if (lnum.hit <= 0) {
        workspace.nvim.call(
          'sign_place',
          [0, signGroup, sign, doc.bufnr, { lnum: lnum.line, priority: signPriority }],
          true
        );
      }
    });
    workspace.nvim.resumeNotification(false, true);
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const config = workspace.getConfiguration('coverage');
  const enabled = config.get<boolean>('enabled', true);
  if (!enabled) {
    return;
  }

  const { logger } = context;

  const signPriority = config.get<number>('signPriority', 10);
  const uncoveredSign = config.get<string>('uncoveredSign.text', '▣');
  const hlGroup = config.get<string>('uncoveredSign.hlGroup', 'UncoveredLine');
  const reportPath = config.get<string>('jsonReportPath', DEFAULT_REPORT_PATH);
  const baseDir = config.get<string>('prefixPath', process.cwd());

  const debounceReadFile = debounce((tpath) => {
    parser.parseFile(tpath, { type: 'jacoco', pathMode: 'unmodified' }).then((results) => {
      const mapped = {};

      results.forEach((entry) => (mapped[path.join(baseDir, entry.file)] = entry));

      cachedReport.json = mapped;

      workspace.document.then((doc) => {
        updateSign(doc, 'CocCoverageUncovered', signGroup, signPriority);
      });
    });
  }, 2000);

  function startWatch(path: string) {
    if (fs.existsSync(path)) {
      // Initial read
      logger.info(`Started watching ${path}`);
      debounceReadFile(path);
    } else {
      logger.error(`Unable to find ${path}`);
    }

    // Start watcher
    const watcher = chokidar.watch(path, { persistent: true });
    watcher
      .on('change', (path) => {
        debounceReadFile(path);
      })
      .on('add', (path) => {
        debounceReadFile(path);
      });
  }

  workspace.nvim.command(
    `sign define CocCoverageUncovered text=${uncoveredSign} texthl=CocCoverageUncoveredSign`,
    true
  );
  workspace.nvim.command(`hi default link CocCoverageUncoveredSign ${hlGroup}`, true);
  // workspace.nvim.command(`hi UncoveredLine guifg=#ffaa00`, true);

  startWatch(path.join(workspace.root, reportPath));

  context.subscriptions.push(
    workspace.registerAutocmd({
      event: ['BufEnter'],
      request: true,
      callback: async () => {
        const doc = await workspace.document;
        updateSign(doc, 'CocCoverageUncovered', signGroup, signPriority);
      },
    })
  );
}

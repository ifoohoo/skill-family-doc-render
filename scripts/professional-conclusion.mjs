// SPDX-License-Identifier: Apache-2.0
// 文档族共同证明：把机械 --check-project 结果投影为 professional-conclusion，
// 并读取本族证明。结构校验与文件读写使用 Foundation 公共入口；本模块只保留
// DOCS 领域码、实际检查范围和原因转换。
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { findSchemaByObject, validateDocument } from 'skill-family-contracts';
import {
  HARNESS_ERROR_KINDS,
  publishFileExclusive,
  readFileStrict,
  resolveContained,
} from 'skill-family-harness-node';
import { RenderedLinksError } from './lib/rendered-links.mjs';

export const PROVIDER_ID = 'skill-family-doc-render';

export const DOCS_CODES = Object.freeze({
  CLEAR: 'DOCS_CLEAR',
  FINDINGS: 'DOCS_FINDINGS',
  INCOMPLETE: 'DOCS_CHECK_INCOMPLETE',
  UNAVAILABLE: 'DOCS_CHECK_UNAVAILABLE',
});

export const CHECK_STAGE_IDS = Object.freeze([
  'input-and-public-safety',
  'coverage-freshness',
  'in-memory-render-and-baseline',
  'internal-links-and-resources',
]);

const MECHANICAL_LIMITATION = '本证明只覆盖渲染器机械检查，不含中文语义审阅。';

const PROVIDER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export class ProofError extends Error {
  constructor(message, exitCode = 2, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.exitCode = exitCode;
  }
}

export function providerInfo(entry) {
  return { id: PROVIDER_ID, version: PROVIDER_VERSION, entry };
}

function professionalSchemaRegistration() {
  return findSchemaByObject('professional-conclusion');
}

export function requireProfessionalSchemaId() {
  const registration = professionalSchemaRegistration();
  if (!registration?.$id || !registration.dialect) {
    throw new ProofError(
      '[skill-family-doc-render] 缺少 Foundation professional-conclusion Schema，需要精确安装 skill-family-contracts@0.22.0',
      2,
    );
  }
  return registration;
}

export function validateProfessionalConclusion(document) {
  const registration = requireProfessionalSchemaId();
  return validateDocument(document, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: 'strict',
  });
}

function uniqueLimitations(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function buildDocsConclusion({
  entry,
  subjectRef,
  subjectRevision,
  checked,
  limitations,
  completion,
  code,
  summary,
  details,
}) {
  const conclusion = {
    schemaVersion: 1,
    kind: 'skill-family.professional-conclusion',
    provider: providerInfo(entry),
    subject: subjectRevision
      ? { ref: subjectRef, revision: subjectRevision }
      : { ref: subjectRef },
    scope: {
      checked: [...checked],
      limitations: uniqueLimitations([MECHANICAL_LIMITATION, ...limitations]),
    },
    outcome: { completion, code, summary },
  };
  if (details !== undefined) conclusion.details = details;
  const validation = validateProfessionalConclusion(conclusion);
  if (!validation.valid) {
    const detail = (validation.errors || []).map((error) => error.message).join('; ');
    throw new ProofError(
      `[skill-family-doc-render] 共同证明结构校验失败: ${validation.errorCode || 'invalid'}${detail ? `: ${detail}` : ''}`,
      2,
    );
  }
  return validation.data;
}

function harnessKind(error) {
  return error?.details?.kind;
}

function errorCauseChain(error) {
  const seen = new Set();
  const chain = [];
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function hasRenderedLinkFailures(error) {
  return errorCauseChain(error).some(
    (item) => item instanceof RenderedLinksError && Array.isArray(item.failures) && item.failures.length > 0,
  );
}

function hasMissingResourceKind(error) {
  return errorCauseChain(error).some(
    (item) => harnessKind(item) === HARNESS_ERROR_KINDS.MISSING_RESOURCE,
  );
}

function isDomainFinding(exitCode, cause) {
  if (exitCode !== 1) return false;
  if (hasRenderedLinkFailures(cause)) return true;
  return !hasMissingResourceKind(cause);
}

export function mapScanToOutcome({
  ok,
  exitCode,
  finished = [],
  attempted = null,
  notReached = [],
  repoSelected = true,
  cause = null,
}) {
  if (ok) {
    return {
      completion: 'complete',
      code: DOCS_CODES.CLEAR,
      summary: '机械项目检查完成，未发现覆盖、渲染、链接或公开安全问题。',
      checked: [...CHECK_STAGE_IDS],
      limitations: [],
    };
  }
  const started = Boolean(repoSelected && (finished.length || attempted));
  if (!started) {
    const remaining = attempted ? [attempted, ...notReached] : [...notReached];
    return {
      completion: 'not-performed',
      code: DOCS_CODES.UNAVAILABLE,
      summary: '未能开展机械项目检查。',
      checked: [],
      limitations: remaining.length ? remaining.map((id) => `未执行检查: ${id}`) : ['机械项目检查未开始。'],
    };
  }
  const findings = isDomainFinding(exitCode, cause);
  const checked = findings && attempted ? [...finished, attempted] : [...finished];
  const limitations = [];
  if (!findings && attempted) limitations.push(`未完成检查: ${attempted}`);
  for (const id of notReached) limitations.push(`未执行检查: ${id}`);
  if (findings) {
    return {
      completion: limitations.length ? 'partial' : 'complete',
      code: DOCS_CODES.FINDINGS,
      summary: '机械项目检查发现覆盖、渲染、链接或公开安全问题。',
      checked,
      limitations,
    };
  }
  return {
    completion: checked.length ? 'partial' : 'not-performed',
    code: DOCS_CODES.INCOMPLETE,
    summary: '机械项目检查未完成所声明范围。',
    checked,
    limitations: limitations.length ? limitations : ['所需项目输入不足。'],
  };
}

function identifiableProvider(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && value.id ? value.id : null;
  const version = typeof value.version === 'string' && value.version ? value.version : null;
  const entry = typeof value.entry === 'string' && value.entry ? value.entry : null;
  if (!id && !version && !entry) return null;
  return {
    ...(id ? { id } : {}),
    ...(version ? { version } : {}),
    ...(entry ? { entry } : {}),
  };
}

function readResult(status, reason, provider, conclusion) {
  return {
    status,
    reason,
    provider: provider || providerInfo('skill-family-doc-render --read-proof'),
    conclusion,
  };
}

export function interpretDocsProof(document) {
  const provider = identifiableProvider(document?.provider);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return readResult('unavailable', '证明不是 JSON 对象。', provider, null);
  }
  let validation;
  try {
    validation = validateProfessionalConclusion(document);
  } catch (cause) {
    if (cause instanceof ProofError) {
      return readResult('unavailable', cause.message, provider, null);
    }
    throw cause;
  }
  if (!validation.valid) {
    return readResult(
      'unavailable',
      `证明不符合 professional-conclusion 结构: ${validation.errorCode || 'invalid'}`,
      provider,
      null,
    );
  }
  const conclusion = validation.data;
  const recorded = conclusion.provider;
  if (recorded.id !== PROVIDER_ID) {
    return readResult(
      'unavailable',
      `证明提供方不是 ${PROVIDER_ID}`,
      recorded,
      null,
    );
  }
  const code = conclusion.outcome.code;
  const known = new Set(Object.values(DOCS_CODES));
  if (!known.has(code)) {
    return readResult(
      'unavailable',
      `未知同版本领域码: ${code}`,
      recorded,
      conclusion,
    );
  }
  if (code === DOCS_CODES.CLEAR && conclusion.outcome.completion === 'complete') {
    return readResult('pass', conclusion.outcome.summary, recorded, conclusion);
  }
  return readResult('not_pass', conclusion.outcome.summary, recorded, conclusion);
}

export function readProofExitCode(status) {
  if (status === 'pass') return 0;
  if (status === 'not_pass') return 1;
  return 2;
}

export async function readProfessionalProof({ proofRoot, proofPath }) {
  const root = resolve(proofRoot);
  const entry = 'skill-family-doc-render --read-proof';
  let relative;
  try {
    await resolveContained(root, proofPath);
    relative = proofPath;
  } catch (cause) {
    return readResult(
      'unavailable',
      `证明路径未收容于 proof-root: ${cause.message}`,
      providerInfo(entry),
      null,
    );
  }
  let receipt;
  try {
    receipt = await readFileStrict(root, relative, { encoding: 'utf8' });
  } catch (cause) {
    const kind = harnessKind(cause);
    let reason = `无法读取证明: ${cause.message}`;
    if (kind === HARNESS_ERROR_KINDS.MISSING_RESOURCE) reason = `证明文件不存在: ${relative}`;
    if (kind === HARNESS_ERROR_KINDS.PATH_TRAVERSAL || kind === HARNESS_ERROR_KINDS.ABSOLUTE_PATH) {
      reason = `证明路径未收容于 proof-root: ${cause.message}`;
    }
    return readResult('unavailable', reason, providerInfo(entry), null);
  }
  let parsed;
  try {
    parsed = JSON.parse(receipt.content);
  } catch (cause) {
    return readResult(
      'unavailable',
      `证明 JSON 损坏: ${cause.message}`,
      providerInfo(entry),
      null,
    );
  }
  return interpretDocsProof(parsed);
}

function splitAbsoluteOutput(absolutePath) {
  const target = resolve(absolutePath);
  if (!isAbsolute(target)) {
    throw new ProofError('[skill-family-doc-render] --conclusion-output 必须是绝对路径', 2);
  }
  let directory = dirname(target);
  const segments = [basename(target)];
  while (!existsSync(directory)) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new ProofError(`[skill-family-doc-render] 无法定位证明输出根目录: ${target}`, 2);
    }
    segments.unshift(basename(directory));
    directory = parent;
  }
  return { root: directory, relPath: join(...segments), target };
}

export async function writeProfessionalConclusion(absolutePath, conclusion) {
  const { root, relPath, target } = splitAbsoluteOutput(absolutePath);
  const body = `${JSON.stringify(conclusion, null, 2)}\n`;
  try {
    const receipt = await publishFileExclusive(root, relPath, body, { createParents: true });
    return { path: receipt.path || target, sha256: receipt.sha256 };
  } catch (cause) {
    if (harnessKind(cause) === HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) {
      throw new ProofError(`[skill-family-doc-render] 证明输出已存在，拒绝覆盖: ${target}`, 2, cause);
    }
    if (cause instanceof ProofError) throw cause;
    throw new ProofError(`[skill-family-doc-render] 证明输出失败: ${cause.message}`, 2, cause);
  }
}

export function conclusionEntryForRepo(repoName) {
  return `skill-family-doc-render --check-project --repo ${repoName}`;
}

export { MECHANICAL_LIMITATION };

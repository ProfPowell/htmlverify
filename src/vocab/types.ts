// The vocabulary of custom elements and web components (spec §7.4): compiled
// from Vanilla Breeze's api.json manifests into a snapshot, plus the project's
// own elements.json.

export type AttributeType = 'boolean' | 'string' | 'number' | 'enum';

export interface VocabAttribute {
  /** native, aria, host-api, data, or class: where the attribute comes from. */
  kind: string;
  /** config, visual-variant, semantic-state, output-state, or internal-hook. */
  purpose: string | null;
  /** input, output, or both; null when the manifest doesn't say. */
  direction: string | null;
  /** null: free text, like an undeclared type. */
  type: AttributeType | null;
  /** Allowed values of an enum; "" allows the empty (bare) form. */
  values: string[] | null;
  default: string | null;
  required: boolean;
  /** false: not part of the public API. */
  public: boolean;
  description: string | null;
}

export interface VocabChildAttribute extends VocabAttribute {
  /** The child elements it applies to, as the manifest names them. */
  on: string;
  name: string;
}

export interface VocabStructure {
  element: string;
  description: string;
  required: boolean;
}

export interface VocabElement {
  type: 'web-component' | 'custom-element' | 'native';
  description: string | null;
  flow: boolean;
  phrasing: boolean;
  /** html-validate permittedContent: element names, @flow, @phrasing, @script; null when undeclared. */
  permittedContent: string[] | null;
  attributes: Record<string, VocabAttribute>;
  childAttributes: VocabChildAttribute[];
  /** Expected children, as the manifest describes them in prose (§7.4). */
  structure: VocabStructure[];
  /** The role the element has after upgrade; null is generic. */
  role: string | null;
}

/** data/vocab/<name>@<version>.json */
export interface Snapshot {
  name: string;
  version: string;
  source: {
    repo: string;
    /** The checkout's commit, or null when it isn't a git checkout. */
    commit: string | null;
    /** Manifest files read, and the SHA-256 over their paths and bytes. */
    files: number;
    sha256: string;
  };
  elements: Record<string, VocabElement>;
}

export interface OpenCutParallelEngineContract {
  tvappEngine: string;
  referenceEngine: string;
  rule: string;
  allowedAlignment: string[];
  boundaries: string[];
}

export const OPENCUT_PARALLEL_ENGINE_CONTRACT: OpenCutParallelEngineContract = {
  tvappEngine: 'TVAPP OpenCut promo editor',
  referenceEngine: 'TrizzyCut full video editor',
  rule: 'TVAPP OpenCut and TrizzyCut are parallel editor engines. TVAPP uses TrizzyCut as a reference for proven media-engine patterns, but TVAPP remains its own promo-video engine for Trey TV.',
  allowedAlignment: [
    'Use compatible export settings names.',
    'Use compatible timeline math concepts.',
    'Use compatible validation discipline.',
    'Use proven media-tool patterns from TrizzyCut when they fit TVAPP.',
    'Extract a shared package later only by intentional design.',
  ],
  boundaries: [
    'Do not make TVAPP depend on TrizzyCut runtime state.',
    'Do not turn TVAPP into a renamed copy of TrizzyCut.',
    'Do not claim a TVAPP capability exists until TVAPP implements and verifies it.',
    'Do not hide differences between the two engines.',
  ],
};

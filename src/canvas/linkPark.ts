/**
 * Target cleanup: remove "spring parked" page movement.
 *
 * We keep `link.apex` as a geometric property for the purple beam shape,
 * but do NOT derive page poses from it anymore. Construction + agent search
 * provides the organization layer instead of spring clustering.
 */
export function resolveParkedPoseForStrand(
  _strand: number,
  _links: {
    id: string
    fromEmphasisId: string
    toEmphasisId: string
    apex: [number, number, number] | null
  }[],
  _edges: { id: string; strandIndex: number }[],
  _preferLinkId: string | null,
  _total: number,
): [number, number, number] | null {
  return null
}

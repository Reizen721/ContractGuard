import baseline from '../../../fixtures/consumer-impact/baseline.json?raw'
import candidate from '../../../fixtures/consumer-impact/candidate.json?raw'
import evidence from '../../../fixtures/consumer-impact/consumers.json?raw'

/** The page and CLI use the same versioned, synthetic demonstration inputs. */
export function consumerExample() { return { baseline, candidate, evidence } }

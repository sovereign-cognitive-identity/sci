import { FlagEmbedding, EmbeddingModel } from 'fastembed'

// BGEBaseENV15: 768-dim, matches schema. Nomic requires fastembed >=2.x.
export const MODEL_ID = process.env['SCI_EMBED_MODEL'] ?? 'BAAI/bge-base-en-v1.5'
export const DIMENSIONS = 768

let _model: FlagEmbedding | null = null

async function getModel(): Promise<FlagEmbedding> {
  if (_model) return _model
  _model = await FlagEmbedding.init({ model: EmbeddingModel.BGEBaseENV15 })
  return _model
}

export async function embed(text: string): Promise<number[]> {
  const model = await getModel()
  const vector = await model.queryEmbed(text)
  return Array.from(vector as unknown as Float32Array)
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const model = await getModel()
  const vectors: number[][] = []
  for await (const batch of model.embed(texts, 32)) {
    for (const vector of batch) {
      vectors.push(Array.from(vector as unknown as Float32Array))
    }
  }
  return vectors
}

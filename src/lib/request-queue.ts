/**
 * Request Queue Module
 * Manages concurrent request limits with priority queue
 */

import consola from "consola"

export interface QueuedRequest {
  id: string
  type: "chat" | "message" | "embedding"
  priority: number
  enqueuedAt: number
  startedAt?: number
  completedAt?: number
  resolve: (value: undefined) => void
  reject: (reason: Error) => void
  timeoutId?: ReturnType<typeof setTimeout>
}

export interface QueueConfig {
  enabled: boolean
  maxConcurrent: number
  maxSize: number
  timeout: number
}

export interface QueueStatus {
  enabled: boolean
  paused: boolean
  size: number
  maxSize: number
  running: number
  maxConcurrent: number
  processed: number
  rejected: number
}

export interface QueueMetrics {
  totalProcessed: number
  totalRejected: number
  totalTimedOut: number
  averageWaitTime: number
  averageProcessTime: number
  peakQueueSize: number
}

// Default configuration
const DEFAULT_CONFIG: QueueConfig = {
  enabled: false,
  maxConcurrent: 3,
  maxSize: 100,
  timeout: 60000, // 60 seconds
}

// Queue state
let queueConfig: QueueConfig = { ...DEFAULT_CONFIG }
let queue: Array<QueuedRequest> = []
let running = 0
let paused = false
const runningRequests: Map<string, QueuedRequest> = new Map()

// Metrics
let metrics: QueueMetrics = {
  totalProcessed: 0,
  totalRejected: 0,
  totalTimedOut: 0,
  averageWaitTime: 0,
  averageProcessTime: 0,
  peakQueueSize: 0,
}

let totalWaitTime = 0

/**
 * Initialize queue with config
 */
export function initQueue(config?: Partial<QueueConfig>): void {
  queueConfig = { ...DEFAULT_CONFIG, ...config }
  consola.debug(
    `Request queue initialized: enabled=${queueConfig.enabled}, maxConcurrent=${queueConfig.maxConcurrent}`,
  )
}

/**
 * Update queue configuration
 */
export function updateQueueConfig(config: Partial<QueueConfig>): void {
  queueConfig = { ...queueConfig, ...config }
  consola.debug("Queue config updated:", queueConfig)
}

/**
 * Get queue configuration
 */
export function getQueueConfig(): QueueConfig {
  return { ...queueConfig }
}

/**
 * Check if queue is enabled
 */
export function isQueueEnabled(): boolean {
  return queueConfig.enabled
}

/**
 * Get current queue status
 */
export function getQueueStatus(): QueueStatus {
  return {
    enabled: queueConfig.enabled,
    paused,
    size: queue.length,
    maxSize: queueConfig.maxSize,
    running,
    maxConcurrent: queueConfig.maxConcurrent,
    processed: metrics.totalProcessed,
    rejected: metrics.totalRejected,
  }
}

/**
 * Get queue metrics
 */
export function getQueueMetrics(): QueueMetrics {
  return { ...metrics }
}

/**
 * Pause the queue
 */
export function pauseQueue(): void {
  paused = true
  consola.info("Request queue paused")
}

/**
 * Resume the queue
 */
export function resumeQueue(): void {
  paused = false
  consola.info("Request queue resumed")
  processNext()
}

/**
 * Clear the queue (reject all pending)
 */
export function clearQueue(): number {
  const count = queue.length
  for (const request of queue) {
    if (request.timeoutId) {
      clearTimeout(request.timeoutId)
    }
    request.reject(new Error("Queue cleared"))
    metrics.totalRejected++
  }
  queue = []
  consola.info(`Queue cleared: ${count} requests rejected`)
  return count
}

/**
 * Generate unique request ID
 */
function generateId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Process next item in queue
 */
function processNext(): void {
  if (paused) return
  if (running >= queueConfig.maxConcurrent) return
  if (queue.length === 0) return

  // Sort by priority (higher first)
  queue.sort((a, b) => b.priority - a.priority)

  const request = queue.shift()
  if (!request) return

  running++
  request.startedAt = Date.now()
  runningRequests.set(request.id, request)

  // Calculate wait time
  const waitTime = request.startedAt - request.enqueuedAt
  totalWaitTime += waitTime
  metrics.averageWaitTime = totalWaitTime / (metrics.totalProcessed + 1)

  // Clear timeout
  if (request.timeoutId) {
    clearTimeout(request.timeoutId)
  }

  // Resolve the promise to let the request proceed
  request.resolve(undefined)
}

/**
 * Mark a request as completed
 */
export function completeRequest(_requestId: string): void {
  running = Math.max(0, running - 1)
  metrics.totalProcessed++
  const request = runningRequests.get(_requestId)
  if (request?.startedAt) {
    const duration = Date.now() - request.startedAt
    const prevTotal = metrics.totalProcessed - 1
    metrics.averageProcessTime =
      prevTotal > 0 ?
        (metrics.averageProcessTime * prevTotal + duration)
        / metrics.totalProcessed
      : duration
    runningRequests.delete(_requestId)
  }

  // Process next in queue
  processNext()
}

/**
 * Enqueue a request
 * Returns a promise that resolves when the request can proceed
 */
export async function enqueueRequest(
  type: "chat" | "message" | "embedding",
  priority: number = 0,
): Promise<string> {
  // If queue is disabled, proceed immediately
  if (!queueConfig.enabled) {
    return generateId()
  }

  // Check if queue is full
  if (queue.length >= queueConfig.maxSize) {
    metrics.totalRejected++
    throw new QueueFullError("Request queue is full")
  }

  const requestId = generateId()

  return new Promise<string>((resolve, reject) => {
    const request: QueuedRequest = {
      id: requestId,
      type,
      priority,
      enqueuedAt: Date.now(),
      resolve: () => resolve(requestId),
      reject,
    }

    // Set timeout
    request.timeoutId = setTimeout(() => {
      const index = queue.findIndex((r) => r.id === requestId)
      if (index !== -1) {
        queue.splice(index, 1)
        metrics.totalTimedOut++
        reject(new QueueTimeoutError("Request timed out in queue"))
      }
    }, queueConfig.timeout)

    queue.push(request)

    // Track peak queue size
    if (queue.length > metrics.peakQueueSize) {
      metrics.peakQueueSize = queue.length
    }

    // Try to process immediately if capacity available
    processNext()
  })
}

/**
 * Custom error for queue full
 */
export class QueueFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QueueFullError"
  }
}

/**
 * Custom error for queue timeout
 */
export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QueueTimeoutError"
  }
}

/**
 * Reset queue metrics
 */
export function resetQueueMetrics(): void {
  metrics = {
    totalProcessed: 0,
    totalRejected: 0,
    totalTimedOut: 0,
    averageWaitTime: 0,
    averageProcessTime: 0,
    peakQueueSize: 0,
  }
  totalWaitTime = 0
}

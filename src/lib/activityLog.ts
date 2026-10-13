import { supabase } from './supabase'

export interface ActivityLogInput {
  action: string
  description?: string
  entity?: string
  entityId?: string | null
  userId?: string | null
  details?: Record<string, unknown>
}

export async function logActivity({
  action,
  description,
  entity,
  entityId = null,
  userId = null,
  details = {},
}: ActivityLogInput): Promise<void> {
  try {
    const desc = description?.trim() || entity?.trim() || 'Unknown'
    const finalDetails: Record<string, unknown> = {
      ...details,
      description: desc,
    }

    const { error } = await supabase.from('activity_logs').insert({
      action,
      entity: desc,
      entity_id: entityId,
      created_by: userId,
      details: finalDetails,
    })

    if (error) {
      console.warn('Activity log failed', error)
    }
  } catch (error) {
    console.warn('Activity log failed', error)
  }
}

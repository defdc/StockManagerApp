import { supabase } from './supabase'

interface ActivityLogInput {
  action: string
  entity: string
  entityId?: string | null
  userId?: string | null
  details?: Record<string, unknown>
}

export async function logActivity({
  action,
  entity,
  entityId = null,
  userId = null,
  details = {},
}: ActivityLogInput): Promise<void> {
  try {
    const { error } = await supabase.from('activity_logs').insert({
      action,
      entity,
      entity_id: entityId,
      created_by: userId,
      details,
    })

    if (error) {
      console.warn('Activity log failed', error)
    }
  } catch (error) {
    console.warn('Activity log failed', error)
  }
}

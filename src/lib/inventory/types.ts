export type InventoryAction = 'read' | 'create' | 'update' | 'delete/archive'

export type RoadmapPhase = 'tier-0-read' | 'tier-1-draft' | 'tier-2-write' | 'deferred'

export type CommandSurface = 'direct-xero' | 'kernel' | 'offline' | 'local'

export interface ImplementedCommand {
  command: string
  domain: string
  surface: CommandSurface
  action: InventoryAction | null
  xeroMethods: string[]
}

export interface TargetCapability {
  domain: string
  resource: string
  actions: InventoryAction[]
  phase: RoadmapPhase
  source: string
}

export interface DomainGroup {
  domain: string
  implemented: ImplementedCommand[]
  targets: TargetCapability[]
}

export interface PhaseCount {
  phase: RoadmapPhase
  targets: number
}

export interface EndpointInventory {
  commands: ImplementedCommand[]
  targets: TargetCapability[]
  domains: DomainGroup[]
  phases: PhaseCount[]
}

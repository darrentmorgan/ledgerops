import type {TargetCapability} from './types.js'

const PRACTICAL_SURFACE = 'ADR-0012 full-capability direction'
const DEFERRED_SOURCE = 'docs/2026-08-23_ledgerops-roadmap-v2.md endpoint matrix ("Deferred")'

/**
 * Target capabilities that are NOT yet implemented.
 *
 * Entries complete the practical Xero accounting surface (ADR-0012) or come from
 * the deferred list recorded in the roadmap v2 endpoint matrix. Each entry must
 * name a real Xero API resource; nothing here is advertised as working.
 */
export const TARGET_CAPABILITIES: TargetCapability[] = [
  {
    domain: 'attachments',
    resource: 'Attachments',
    actions: ['read', 'create'],
    phase: 'deferred',
    source: DEFERRED_SOURCE,
  },
  {
    domain: 'bank-transactions',
    resource: 'BankTransactions',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'batch-payments',
    resource: 'BatchPayments',
    actions: ['read', 'create', 'delete/archive'],
    phase: 'deferred',
    source: DEFERRED_SOURCE,
  },
  {
    domain: 'contact-groups',
    resource: 'ContactGroups',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'contacts',
    resource: 'Contacts',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'credit-notes',
    resource: 'CreditNotes',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'expense-claims',
    resource: 'ExpenseClaims',
    actions: ['read', 'create', 'update'],
    phase: 'deferred',
    source: DEFERRED_SOURCE,
  },
  {
    domain: 'invoices',
    resource: 'Invoices',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {domain: 'items', resource: 'Items', actions: ['delete/archive'], phase: 'tier-2-write', source: PRACTICAL_SURFACE},
  {
    domain: 'manual-journals',
    resource: 'ManualJournals',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'payments',
    resource: 'Payments',
    actions: ['update', 'delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'payroll',
    resource: 'Payroll (payrollApi)',
    actions: ['read', 'create', 'update'],
    phase: 'deferred',
    source: DEFERRED_SOURCE,
  },
  {domain: 'quotes', resource: 'Quotes', actions: ['delete/archive'], phase: 'tier-2-write', source: PRACTICAL_SURFACE},
  {
    domain: 'repeating-invoices',
    resource: 'RepeatingInvoices',
    actions: ['read', 'create', 'update'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'tracking-categories',
    resource: 'TrackingCategories',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
  {
    domain: 'tracking-options',
    resource: 'TrackingOptions',
    actions: ['delete/archive'],
    phase: 'tier-2-write',
    source: PRACTICAL_SURFACE,
  },
]

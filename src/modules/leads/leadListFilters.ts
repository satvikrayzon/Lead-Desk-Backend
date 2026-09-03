import { ILead } from '../../models/Lead';

export interface AgentLeadQuery {
  search?: string;
  tab?: string;
  lead_status?: string;
  lead_stage?: string;
  priority?: string;
  customer_type?: string;
  product?: string;
  state?: string;
  district?: string;
  city?: string;
}

type PopulatedAssignment = { leadId: ILead; assignedAt: Date };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseAgentLeadQuery(query: Record<string, unknown>): AgentLeadQuery {
  return {
    search: asString(query.search),
    tab: asString(query.tab),
    lead_status: asString(query.lead_status),
    lead_stage: asString(query.lead_stage),
    priority: asString(query.priority),
    customer_type: asString(query.customer_type),
    product: asString(query.product),
    state: asString(query.state),
    district: asString(query.district),
    city: asString(query.city),
  };
}

export function filterAgentLeadAssignments(
  assignments: PopulatedAssignment[],
  query: AgentLeadQuery
): PopulatedAssignment[] {
  let filtered = assignments.filter((a) => a.leadId);

  if (query.lead_status) {
    filtered = filtered.filter((a) => (a.leadId.leadStatus ?? 'Open') === query.lead_status);
  }
  if (query.lead_stage) {
    filtered = filtered.filter((a) => a.leadId.leadStage === query.lead_stage);
  }
  if (query.priority) {
    filtered = filtered.filter((a) => a.leadId.priority === query.priority);
  }
  if (query.customer_type) {
    filtered = filtered.filter((a) => a.leadId.customerType === query.customer_type);
  }
  if (query.product) {
    filtered = filtered.filter((a) => a.leadId.product === query.product);
  }
  if (query.state) {
    filtered = filtered.filter((a) => a.leadId.state === query.state);
  }
  if (query.district) {
    filtered = filtered.filter((a) => a.leadId.district === query.district);
  }
  if (query.city) {
    filtered = filtered.filter((a) => a.leadId.city === query.city);
  }

  if (query.tab === 'called') {
    filtered = filtered.filter((a) => (a.leadId.callCount ?? 0) > 0);
  } else if (query.tab === 'remaining') {
    filtered = filtered.filter((a) => (a.leadId.callCount ?? 0) === 0);
  }

  if (query.search) {
    const term = query.search.toLowerCase();
    filtered = filtered.filter((a) => {
      const lead = a.leadId;
      return (
        lead.name.toLowerCase().includes(term) ||
        lead.phoneNumber.includes(query.search!) ||
        (lead.companyName ?? '').toLowerCase().includes(term) ||
        (lead.company ?? '').toLowerCase().includes(term) ||
        (lead.contactPerson ?? '').toLowerCase().includes(term) ||
        (lead.state ?? '').toLowerCase().includes(term) ||
        (lead.district ?? '').toLowerCase().includes(term) ||
        (lead.city ?? '').toLowerCase().includes(term)
      );
    });
  }

  return filtered;
}

export function extractAgentFilterOptions(leads: ILead[]) {
  const uniq = (values: (string | undefined | null)[]) =>
    [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort();

  return {
    states: uniq(leads.map((l) => l.state)),
    districts: uniq(leads.map((l) => l.district)),
    cities: uniq(leads.map((l) => l.city)),
    lead_statuses: uniq(leads.map((l) => l.leadStatus ?? 'Open')),
    lead_stages: uniq(leads.map((l) => l.leadStage)),
    priorities: uniq(leads.map((l) => l.priority)),
    customer_types: uniq(leads.map((l) => l.customerType)),
    products: uniq(leads.map((l) => l.product)),
  };
}

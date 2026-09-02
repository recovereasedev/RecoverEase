/**
 * Generates `src/types/database.types.ts` from the migration files.
 *
 * Supabase's own type generator needs a live project. This produces the same
 * shape by applying the committed migrations to an in-process PostgreSQL and
 * introspecting the result, so the types are derived from the migrations that
 * actually ship rather than maintained by hand beside them.
 *
 *   npm run db:types
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { createTestDatabase } from '../tests/db/helpers/database.ts'

const OUTPUT = fileURLToPath(
  new URL('../src/types/database.types.ts', import.meta.url),
)

type ColumnRow = {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
  has_default: boolean
  is_identity: 'YES' | 'NO'
}

type EnumRow = { enum_name: string; enum_value: string }

type RelationshipRow = {
  table_name: string
  constraint_name: string
  columns: string[]
  referenced_relation: string
  referenced_columns: string[]
  is_one_to_one: boolean
}

/** Maps a PostgreSQL type onto the TypeScript the PostgREST client returns. */
function toTsType(column: ColumnRow): string {
  if (column.data_type === 'ARRAY') {
    // udt_name for an array is the element type prefixed with an underscore.
    const element = column.udt_name.replace(/^_/, '')
    return `${scalarToTsType(element)}[]`
  }

  if (column.data_type === 'USER-DEFINED') {
    return `Database['public']['Enums']['${column.udt_name}']`
  }

  return scalarToTsType(column.udt_name)
}

function scalarToTsType(udtName: string): string {
  switch (udtName) {
    case 'bool':
      return 'boolean'
    case 'int2':
    case 'int4':
    case 'int8':
    case 'float4':
    case 'float8':
    case 'numeric':
      return 'number'
    case 'json':
    case 'jsonb':
      return 'Json'
    default:
      // uuid, text, varchar, timestamptz, date, time and friends all arrive
      // over the wire as strings.
      return 'string'
  }
}

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`
}

async function main(): Promise<void> {
  const database = await createTestDatabase()

  try {
    const columns = await database.asService<ColumnRow>(`
      select c.table_name,
             c.column_name,
             c.data_type,
             c.udt_name,
             c.is_nullable,
             (c.column_default is not null) as has_default,
             c.is_identity
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema
         and t.table_name = c.table_name
       where c.table_schema = 'public'
         and t.table_type = 'BASE TABLE'
       order by c.table_name, c.ordinal_position
    `)

    const enums = await database.asService<EnumRow>(`
      select t.typname as enum_name, e.enumlabel as enum_value
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
       order by t.typname, e.enumsortorder
    `)

    // supabase-js needs each table's foreign keys to type embedded selects
    // such as `.select('*, patient ( pat_first_name )')`. Without a
    // Relationships array the table does not satisfy its GenericTable
    // constraint at all, and every query silently degrades to `never`.
    const relationships = await database.asService<RelationshipRow>(`
      select child.relname          as table_name,
             con.conname            as constraint_name,
             array_agg(child_att.attname order by child_key.ordinality)
               as columns,
             parent.relname         as referenced_relation,
             array_agg(parent_att.attname order by child_key.ordinality)
               as referenced_columns,
             -- One-to-one when the referencing columns are themselves unique.
             exists (
               select 1
                 from pg_index idx
                where idx.indrelid = con.conrelid
                  and idx.indisunique
                  and idx.indnatts = array_length(con.conkey, 1)
                  and idx.indkey::int2[] @> con.conkey
             )                      as is_one_to_one
        from pg_constraint con
        join pg_class child on child.oid = con.conrelid
        join pg_class parent on parent.oid = con.confrelid
        join pg_namespace ns on ns.oid = child.relnamespace
        join unnest(con.conkey) with ordinality as child_key(attnum, ordinality)
          on true
        join unnest(con.confkey) with ordinality as parent_key(attnum, ordinality)
          on parent_key.ordinality = child_key.ordinality
        join pg_attribute child_att
          on child_att.attrelid = con.conrelid
         and child_att.attnum = child_key.attnum
        join pg_attribute parent_att
          on parent_att.attrelid = con.confrelid
         and parent_att.attnum = parent_key.attnum
       where con.contype = 'f'
         and ns.nspname = 'public'
       group by child.relname, con.conname, parent.relname, con.conrelid,
                con.conkey
       order by 1, 2
    `)

    const byRelationship = new Map<string, RelationshipRow[]>()
    for (const row of relationships) {
      const existing = byRelationship.get(row.table_name)
      if (existing) existing.push(row)
      else byRelationship.set(row.table_name, [row])
    }

    const byTable = new Map<string, ColumnRow[]>()
    for (const column of columns) {
      const existing = byTable.get(column.table_name)
      if (existing) existing.push(column)
      else byTable.set(column.table_name, [column])
    }

    const byEnum = new Map<string, string[]>()
    for (const row of enums) {
      const existing = byEnum.get(row.enum_name)
      if (existing) existing.push(row.enum_value)
      else byEnum.set(row.enum_name, [row.enum_value])
    }

    const lines: string[] = [
      '/**',
      ' * Generated by `npm run db:types` from supabase/migrations.',
      ' *',
      ' * Do not edit by hand: regenerate after changing a migration, so the',
      ' * types can never drift from the schema they describe.',
      ' */',
      '',
      'export type Json =',
      '  | string',
      '  | number',
      '  | boolean',
      '  | null',
      '  | { [key: string]: Json | undefined }',
      '  | Json[]',
      '',
      'export type Database = {',
      '  public: {',
      '    Tables: {',
    ]

    for (const [tableName, tableColumns] of [...byTable].sort()) {
      lines.push(`      ${tableName}: {`)

      lines.push('        Row: {')
      for (const column of tableColumns) {
        const nullable = column.is_nullable === 'YES' ? ' | null' : ''
        lines.push(
          `          ${quoteKey(column.column_name)}: ${toTsType(column)}${nullable}`,
        )
      }
      lines.push('        }')

      lines.push('        Insert: {')
      for (const column of tableColumns) {
        // A column is optional on insert when the database can supply it.
        const optional =
          column.has_default ||
          column.is_nullable === 'YES' ||
          column.is_identity === 'YES'
        const nullable = column.is_nullable === 'YES' ? ' | null' : ''
        lines.push(
          `          ${quoteKey(column.column_name)}${optional ? '?' : ''}: ${toTsType(column)}${nullable}`,
        )
      }
      lines.push('        }')

      lines.push('        Update: {')
      for (const column of tableColumns) {
        const nullable = column.is_nullable === 'YES' ? ' | null' : ''
        lines.push(
          `          ${quoteKey(column.column_name)}?: ${toTsType(column)}${nullable}`,
        )
      }
      lines.push('        }')

      const tableRelationships = byRelationship.get(tableName) ?? []
      if (tableRelationships.length === 0) {
        lines.push('        Relationships: []')
      } else {
        lines.push('        Relationships: [')
        for (const relationship of tableRelationships) {
          lines.push('          {')
          lines.push(
            `            foreignKeyName: '${relationship.constraint_name}'`,
          )
          lines.push(
            `            columns: [${relationship.columns.map((c) => `'${c}'`).join(', ')}]`,
          )
          lines.push(
            `            isOneToOne: ${relationship.is_one_to_one}`,
          )
          lines.push(
            `            referencedRelation: '${relationship.referenced_relation}'`,
          )
          lines.push(
            `            referencedColumns: [${relationship.referenced_columns.map((c) => `'${c}'`).join(', ')}]`,
          )
          lines.push('          },')
        }
        lines.push('        ]')
      }

      lines.push('      }')
    }

    lines.push('    }')
    lines.push('    Views: { [_ in never]: never }')

    lines.push('    Functions: {')
    lines.push('      admin_dashboard_stats: {')
    lines.push('        Args: Record<PropertyKey, never>')
    lines.push('        Returns: Json')
    lines.push('      }')
    lines.push('      admin_chatbot_usage: {')
    lines.push('        Args: { window_days?: number }')
    lines.push('        Returns: Json')
    lines.push('      }')
    lines.push('    }')

    lines.push('    Enums: {')
    for (const [enumName, values] of [...byEnum].sort()) {
      const union = values.map((value) => `'${value}'`).join(' | ')
      lines.push(`      ${enumName}: ${union}`)
    }
    lines.push('    }')

    lines.push('    CompositeTypes: { [_ in never]: never }')
    lines.push('  }')
    lines.push('}')
    lines.push('')
    lines.push(
      '/** Convenience alias: the Row shape of a public table. */',
    )
    lines.push(
      "export type Tables<T extends keyof Database['public']['Tables']> =",
    )
    lines.push("  Database['public']['Tables'][T]['Row']")
    lines.push('')
    lines.push('/** Convenience alias: the Insert shape of a public table. */')
    lines.push(
      "export type TablesInsert<T extends keyof Database['public']['Tables']> =",
    )
    lines.push("  Database['public']['Tables'][T]['Insert']")
    lines.push('')
    lines.push('/** Convenience alias: the Update shape of a public table. */')
    lines.push(
      "export type TablesUpdate<T extends keyof Database['public']['Tables']> =",
    )
    lines.push("  Database['public']['Tables'][T]['Update']")
    lines.push('')
    lines.push('/** Convenience alias: a public enum union. */')
    lines.push("export type Enums<T extends keyof Database['public']['Enums']> =")
    lines.push("  Database['public']['Enums'][T]")
    lines.push('')

    await writeFile(OUTPUT, lines.join('\n'), 'utf8')

    console.log(
      `Generated ${OUTPUT}\n  ${byTable.size} tables, ${byEnum.size} enums`,
    )
  } finally {
    await database.close()
  }
}

await main()

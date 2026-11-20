# frozen_string_literal: true

class CreateImportAndReconciliationTables < ActiveRecord::Migration[8.1]
  def change
    create_table :import_batches, id: :uuid do |t|
      t.binary :sales_bytes, null: false
      t.binary :payments_bytes, null: false
      t.string :sales_digest, null: false, limit: 64
      t.string :payments_digest, null: false, limit: 64
      t.text :sales_filename, null: false
      t.text :payments_filename, null: false
      t.datetime :created_at, null: false
      t.index %i[sales_digest payments_digest]
    end

    create_table :source_events do |t|
      t.references :import_batch, type: :uuid, null: false, foreign_key: true, index: false
      t.string :source, null: false
      t.integer :record_number, null: false
      t.string :event_id, null: false, limit: 64, collation: "C"
      t.string :store_id, null: false, limit: 64, collation: "C"
      t.date :business_date, null: false
      t.string :payment_method, null: false
      t.string :event_type, null: false
      t.bigint :amount, null: false
      t.string :original_event_id, limit: 64, collation: "C"

      t.index %i[import_batch_id source store_id event_id], unique: true
      t.index %i[import_batch_id source record_number], unique: true
      t.index %i[import_batch_id source store_id original_event_id], where: "original_event_id IS NOT NULL"
    end
    add_foreign_key :source_events, :source_events,
                    column: %i[import_batch_id source store_id original_event_id],
                    primary_key: %i[import_batch_id source store_id event_id]

    create_table :reconciliation_results do |t|
      t.references :import_batch, type: :uuid, null: false, foreign_key: true, index: false
      t.string :store_id, null: false, limit: 64, collation: "C"
      t.date :business_date, null: false
      t.string :payment_method, null: false
      t.bigint :sales_net
      t.bigint :payments_net
      t.bigint :difference
      t.string :classification, null: false
      t.string :investigation_status

      t.index %i[import_batch_id store_id business_date payment_method], unique: true
    end
  end
end

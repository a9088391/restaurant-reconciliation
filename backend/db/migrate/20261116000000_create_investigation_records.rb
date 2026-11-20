# frozen_string_literal: true

class CreateInvestigationRecords < ActiveRecord::Migration[8.1]
  def change
    create_table :investigation_records do |t|
      t.references :reconciliation_result, null: false, foreign_key: true, index: false
      t.string :status, null: false
      t.text :note, null: false
      t.datetime :created_at, null: false

      t.index %i[reconciliation_result_id id]
      t.check_constraint "status IN ('pending', 'processed')", name: "investigation_records_status"
    end
  end
end

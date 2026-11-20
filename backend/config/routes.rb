# frozen_string_literal: true

Rails.application.routes.draw do
  scope :api do
    get "csrf_token", to: "csrf_tokens#show"
    resources :import_batches, only: %i[index show create]
    scope "import_batches/:import_batch_id/results/:result_id" do
      get "investigation", to: "investigations#show"
      patch "investigation", to: "investigations#update"
    end
  end
end

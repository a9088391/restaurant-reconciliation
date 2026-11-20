# frozen_string_literal: true

class CsrfTokensController < ApplicationController
  # 簽發目前會話的寫入 token，並以 no-store 避免快取重用。
  def show
    no_store
    render json: { csrf_token: form_authenticity_token }
  end
end

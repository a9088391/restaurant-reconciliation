# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # 本機免登入仍以會話 token 防止外部網頁代送寫入，驗證失敗回傳統一 JSON 錯誤。
  protect_from_forgery with: :exception

  rescue_from ActionController::InvalidAuthenticityToken do
    render_error("invalid_csrf_token", "請重新載入頁面後再提交。", :forbidden)
  end

  private

  def render_error(code, message, status)
    render json: { error: { source: nil, code: code, message: message } }, status: status
  end
end

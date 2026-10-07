class LoginController < ApplicationController
  def done
    # ruleid: radr.ruby.open-redirect
    redirect_to params[:return_to]
    # ruleid: radr.ruby.open-redirect
    redirect_to "#{params[:host]}/home"
    # ok: radr.ruby.open-redirect
    redirect_to root_path
  end
end

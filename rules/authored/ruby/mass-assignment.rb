class AccountsController < ApplicationController
  def update
    # ruleid: radr.ruby.mass-assignment
    @account.update(params.require(:account).permit!)
    # ruleid: radr.ruby.mass-assignment
    Account.create(params)
    # ok: radr.ruby.mass-assignment
    @account.update(params.require(:account).permit(:name, :email))
  end
end

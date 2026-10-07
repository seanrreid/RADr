class FilesController < ApplicationController
  def download
    # ruleid: radr.ruby.path-traversal
    send_file "/srv/files/#{params[:name]}"
    # ruleid: radr.ruby.path-traversal
    body = File.read(Rails.root.join("data", params[:file]))
    # ok: radr.ruby.path-traversal
    send_file "/srv/files/#{File.basename(params[:name])}"
    # ok: radr.ruby.path-traversal
    File.read("/srv/files/terms.txt")
  end
end
